/**
 * Drives the real built server over HTTP against real Postgres, walking the
 * build spec's test checklist. Run via `npm run e2e`.
 */
import { createHmac } from 'node:crypto'
import { count, one, patch, remove, resetToRoster, select } from './db.mjs'
import { phone } from './student.mjs'

// localhost, not 127.0.0.1: WebAuthn will not accept an IP address as a
// Relying Party ID, so a passkey cannot be created on 127.0.0.1 at all.
const BASE = process.env.BASE_URL ?? 'http://localhost:3100'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
const DEFAULT_WINDOW = 15

if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD is not set.')

let pass = 0
let fail = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Waits until the current rotation window has at least `minMsLeft` remaining.
 *
 * Without this the timing-sensitive checks are flaky: if the window flips between
 * us minting a `w+1` token and the server verifying it, `w+1` becomes the live
 * window and the request rightly succeeds — failing a test that is actually fine.
 */
async function windowRoom(minMsLeft = 6000, period = DEFAULT_WINDOW) {
  const left = period * 1000 - (Date.now() % (period * 1000))
  if (left < minMsLeft) await sleep(left + 200)
}

const uuid = () => crypto.randomUUID()

async function api(path, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  })
  const type = res.headers.get('content-type') ?? ''
  const data = type.includes('json') ? await res.json().catch(() => ({})) : null
  return { status: res.status, data, res }
}

function tokenFor(secret, sessionId, w) {
  return createHmac('sha256', secret).update(`${sessionId}:${w}`).digest('base64url').slice(0, 12)
}
const nowWindow = (period = DEFAULT_WINDOW) => Math.floor(Date.now() / 1000 / period)

async function main() {
  console.log('\n— resetting database —')

  // Chosen mode: wipe sessions/attendance/audit before each run. Guarded so a
  // stray invocation later in the term cannot silently destroy real attendance.
  const existingMarks = await count('attendance')
  if (existingMarks > 0 && process.env.E2E_CONFIRM_WIPE !== '1') {
    console.error(
      `\nRefusing to run: ${existingMarks} attendance rows already exist.\n` +
        'This harness deletes all sessions, attendance and audit entries.\n' +
        'If that is genuinely what you want, re-run with E2E_CONFIRM_WIPE=1.\n'
    )
    process.exit(2)
  }

  // Failed sign-ins now persist in a table, so a previous run's brute-force
  // test would throttle this one out of its own login.
  await remove('login_attempts', 'id=gt.0')
  await remove('admin_grants', 'id=not.is.null')
  await resetToRoster()

  const studentCount = await count('students')
  console.log(`students seeded: ${studentCount}`)
  if (studentCount === 0) {
    console.error('No students. Run `npm run seed -- "Soft Skills.xlsx"` first.')
    process.exit(2)
  }

  // ── admin auth ────────────────────────────────────────────────────────────
  console.log('\n— admin auth —')
  const bad = await api('/api/admin/login', { method: 'POST', body: { password: 'nope' } })
  check('wrong admin password is refused', bad.status === 401)

  const login = await api('/api/admin/login', {
    method: 'POST',
    body: { password: ADMIN_PASSWORD },
  })
  const setCookie = login.res.headers.getSetCookie?.() ?? []
  const admin = setCookie.map((c) => c.split(';')[0]).join('; ')
  check('admin login sets an httpOnly cookie', login.status === 200 && admin.includes('att_admin'))
  check(
    'admin cookie is httpOnly',
    setCookie.some((c) => /httponly/i.test(c))
  )

  console.log('\n— unauthenticated writes are refused (checklist: 401s) —')
  for (const [path, method, body] of [
    ['/api/export', 'GET', undefined],
    ['/api/roster', 'GET', undefined],
    ['/api/token?s=00000000-0000-4000-8000-000000000000', 'GET', undefined],
    ['/api/marks', 'POST', { sessionId: uuid(), studentIds: [uuid()] }],
    ['/api/marks/remove', 'POST', { sessionId: uuid(), studentId: uuid() }],
    ['/api/sessions', 'POST', {}],
    ['/api/sessions/state', 'POST', { sessionId: uuid(), open: false }],
    ['/api/grants', 'GET', undefined],
    ['/api/students', 'POST', { rollNo: 'MT9999998', name: 'Nobody' }],
    ['/api/grants', 'POST', { label: 'x', hours: 2 }],
    ['/api/grants/revoke', 'POST', { grantId: uuid() }],
    ['/api/whoami', 'GET', undefined],
  ]) {
    const r = await api(path, { method, body })
    check(`${method} ${path} without admin cookie → 401`, r.status === 401, `got ${r.status}`)
  }

  // ── start a live session ──────────────────────────────────────────────────
  console.log('\n— live session —')
  const started = await api('/api/sessions', {
    method: 'POST',
    body: { durationMinutes: 45, windowSeconds: 15 },
    cookie: admin,
  })
  check('start session returns 201', started.status === 201, `got ${started.status}`)
  const session = started.data.session
  check('session is scannable', session?.scannable === true)
  check('the chosen rotation period is stored', session?.windowSeconds === 15)
  const plannedEnd = new Date(session.expiresAt).getTime() - Date.now()
  check(
    'the chosen duration sets the end time (45 min)',
    Math.abs(plannedEnd - 45 * 60_000) < 20_000,
    `${Math.round(plannedEnd / 60_000)} min`
  )

  for (const [field, value, expected] of [
    ['durationMinutes', 0, 'BAD_DURATION'],
    ['durationMinutes', 601, 'BAD_DURATION'],
    ['durationMinutes', 30.5, 'BAD_DURATION'],
    ['windowSeconds', 4, 'BAD_WINDOW'],
    ['windowSeconds', 301, 'BAD_WINDOW'],
  ]) {
    const r = await api('/api/sessions', {
      method: 'POST',
      body: { classDate: '2020-01-01', [field]: value },
      cookie: admin,
    })
    check(`${field}=${value} is refused`, r.data?.error === expected, JSON.stringify(r.data))
  }

  const secret = (await one('sessions', `select=secret&id=eq.${session.id}`)).secret
  check('secret is 32 random bytes as hex', /^[0-9a-f]{64}$/.test(secret))

  const tokenNoAuth = await api(`/api/token?s=${session.id}`)
  check(
    'a student who scanned cannot poll /api/token for fresh codes',
    tokenNoAuth.status === 401,
    `got ${tokenNoAuth.status}`
  )
  await windowRoom()
  const tokenRes = await api(`/api/token?s=${session.id}`, { cookie: admin })
  check('GET /api/token returns the live token to the admin', tokenRes.status === 200)
  check('the token response reports the session rotation', tokenRes.data.windowSeconds === 15)
  check(
    'refresh is scheduled inside one rotation period',
    tokenRes.data.refreshInMs > 0 && tokenRes.data.refreshInMs <= 15_000
  )
  check(
    '/api/token never leaks the secret',
    !JSON.stringify(tokenRes.data).includes(secret)
  )
  const w = nowWindow()
  check('token matches the HMAC of the current window', tokenRes.data.token === tokenFor(secret, session.id, w))

  // Full roster: grants are issued by student id now, not a free-text label.
  const students = await select('students', 'select=id,roll_no,name&order=s_no.asc')
  const [rollA, rollB, rollC] = students.slice(0, 3).map((r) => r.roll_no)

  // ── registering a passkey ─────────────────────────────────────────────────
  console.log('\n— registering a passkey —')
  const phoneA = phone(BASE)
  let t = tokenFor(secret, session.id, nowWindow())

  // A phone with no passkey cannot sign in. The server never learns this — the
  // authenticator simply has nothing to offer — which is why the screen falls
  // back to asking for a roll number.
  const noPasskey = await phoneA.markPresent(session.id, t)
  check('a phone with no passkey has nothing to sign with', noPasskey.stage === 'no-passkey')

  const registered = await phoneA.register(session.id, t, rollA)
  check(
    'registering creates a passkey and marks present',
    registered.data?.status === 'REGISTERED',
    JSON.stringify(registered.data)
  )
  check(
    'registration wrote exactly one attendance row',
    (await count('attendance', `session_id=eq.${session.id}`)) === 1
  )
  check(
    'and exactly one credential',
    (await count('student_credentials')) === 1
  )
  check(
    'the credential belongs to the student who claimed the roll number',
    (await one('student_credentials', 'select=student_id')).student_id ===
      students.find((r) => r.roll_no === rollA).id
  )

  // Registration is authorised by presence, so a stale token must not do.
  const staleRegister = await phone(BASE).register(
    session.id,
    tokenFor(secret, session.id, nowWindow() - 4),
    rollB
  )
  check(
    'registering with a stale token is refused',
    staleRegister.data?.error === 'BAD_TOKEN',
    JSON.stringify(staleRegister.data)
  )

  const unknownRoll = await phone(BASE).register(session.id, t, 'MT9999999')
  check('unknown roll number → UNKNOWN_ROLL', unknownRoll.data?.error === 'UNKNOWN_ROLL')

  // A second phone may register for the same student — that is the whole point
  // of one-to-many credentials, and what removed the admin device reset.
  const phoneA2 = phone(BASE)
  const second = await phoneA2.register(session.id, t, rollA)
  check(
    'the same student can register a second phone, with no admin involved',
    second.data?.status === 'REGISTERED',
    JSON.stringify(second.data)
  )
  check('both credentials are stored', (await count('student_credentials')) === 2)
  check(
    'and still just one attendance row for that student',
    (await count('attendance', `session_id=eq.${session.id}`)) === 1
  )
  check(
    'the second phone signs in on its own passkey',
    (await phoneA2.markPresent(session.id, tokenFor(secret, session.id, nowWindow())))
      .data?.rollNo === rollA
  )

  // ── token rotation ────────────────────────────────────────────────────────
  console.log('\n— rotating token —')
  await windowRoom()
  const wNow = nowWindow()
  const prev = await phoneA.markPresent(session.id, tokenFor(secret, session.id, wNow - 1))
  check('token from the previous window w-1 is accepted', prev.data?.status === 'MARKED', JSON.stringify(prev.data))

  await windowRoom()
  const wFresh = nowWindow()
  const next = await phoneA.markPresent(session.id, tokenFor(secret, session.id, wFresh + 1))
  check('token from the next window w+1 is rejected', next.data?.error === 'BAD_TOKEN')

  const stale = await phoneA.markPresent(session.id, tokenFor(secret, session.id, wNow - 3))
  check(
    'screenshotted QR from 45s ago is rejected',
    stale.data?.error === 'BAD_TOKEN',
    JSON.stringify(stale.data)
  )

  const forged = await phoneA.markPresent(session.id, 'aaaaaaaaaaaa')
  check('forged token is rejected', forged.data?.error === 'BAD_TOKEN')

  // ── the passkey itself must hold up ───────────────────────────────────────
  console.log('\n— what the assertion has to prove —')
  t = tokenFor(secret, session.id, nowWindow())
  const badSig = await phoneA.markPresent(session.id, t, { tamper: 'signature' })
  check(
    'a tampered signature is refused',
    badSig.data?.error === 'BAD_ASSERTION',
    JSON.stringify(badSig.data)
  )
  const badChallenge = await phoneA.markPresent(session.id, t, { tamper: 'challenge' })
  check(
    'a challenge the server never issued is refused',
    badChallenge.data?.error === 'CHALLENGE_EXPIRED',
    JSON.stringify(badChallenge.data)
  )

  // Challenges are single-use: the delete that reads one is the gate.
  const optionsRes = await api('/api/passkey/auth/options', {
    method: 'POST',
    body: { s: session.id, t },
  })
  const reused = optionsRes.data.options.challenge
  const first = await api('/api/passkey/auth/verify', {
    method: 'POST',
    body: {
      s: session.id,
      t,
      challenge: reused,
      response: phoneA.authenticator.authenticate(optionsRes.data.options, optionsRes.data.origin),
    },
  })
  check('a fresh challenge verifies once', first.status === 200, JSON.stringify(first.data))
  const replayed = await api('/api/passkey/auth/verify', {
    method: 'POST',
    body: {
      s: session.id,
      t,
      challenge: reused,
      response: phoneA.authenticator.authenticate(
        { ...optionsRes.data.options, challenge: reused },
        optionsRes.data.origin
      ),
    },
  })
  check(
    'and the same challenge cannot be spent twice',
    replayed.data?.error === 'CHALLENGE_EXPIRED',
    JSON.stringify(replayed.data)
  )

  // ── idempotent marking ────────────────────────────────────────────────────
  console.log('\n— repeat and concurrent scans —')
  t = tokenFor(secret, session.id, nowWindow())
  const again = await phoneA.markPresent(session.id, t)
  check('same student signing in twice succeeds silently', again.status === 200 && again.data.status === 'MARKED')
  check(
    'still exactly one attendance row for that student',
    (await count('attendance', `session_id=eq.${session.id}`)) === 1
  )

  // Two more students register, then all three sign in at once.
  const phoneB = phone(BASE)
  const phoneC = phone(BASE)
  await phoneB.register(session.id, t, rollB)
  await phoneC.register(session.id, t, rollC)

  t = tokenFor(secret, session.id, nowWindow())
  const concurrent = await Promise.all(
    [phoneA, phoneB, phoneC, phoneA, phoneB].map((p) => p.markPresent(session.id, t))
  )
  check(
    'five simultaneous sign-ins from three phones all succeed',
    concurrent.every((r) => r.data?.status === 'MARKED'),
    JSON.stringify(concurrent.map((r) => r.data?.status ?? r.data?.error))
  )
  check(
    'no duplicate rows from the race — exactly three marks',
    (await count('attendance', `session_id=eq.${session.id}`)) === 3
  )

  // ── /me isolation ─────────────────────────────────────────────────────────
  console.log('\n— /me shows only the caller —')
  const me = await phoneA.record()
  check('/api/me returns the caller', me.status === 200 && me.data.rollNo === rollA)
  check('/api/me reports 1 of 1 present', me.data.present === 1 && me.data.total === 1)
  const meBody = JSON.stringify(me.data)
  check('/api/me leaks no other roll number', !meBody.includes(rollB) && !meBody.includes(rollC))

  // A phone that has never signed in carries no session, so there is nothing
  // to identify it — and unlike the device id it replaced, a session cannot be
  // guessed or forged, only issued by a verified assertion.
  const meNobody = await api('/api/me', { method: 'POST', body: {} })
  check('/api/me with no session → NOT_REGISTERED', meNobody.status === 404)
  const meForged = await api('/api/me', {
    method: 'POST',
    body: {},
    cookie: `att_student=${students[0].id}.9999999999.not-a-real-signature`,
  })
  check('/api/me rejects a forged session cookie', meForged.status === 404)

  // Reading a record is not marking attendance: the session is enough for /me
  // and useless for anything that records presence.
  phoneA.forgetSession()
  const meAfterClear = await phoneA.record()
  check('clearing the session logs them out of /me', meAfterClear.status === 404)
  check(
    'but the passkey still marks them present',
    (await phoneA.markPresent(session.id, tokenFor(secret, session.id, nowWindow())))
      .data?.status === 'MARKED'
  )

  // ── roster + toggle ───────────────────────────────────────────────────────
  console.log('\n— roster grid and taps —')
  const roster = await api(`/api/roster?s=${session.id}`, { cookie: admin })
  check('roster lists every student', roster.data.students.length === studentCount)
  check('roster counts the three marks', roster.data.markedCount === 3)
  check('roster never ships the session secret', !JSON.stringify(roster.data).includes(secret))
  const scanned = roster.data.students.find((s) => s.rollNo === rollA)
  check('a scanned mark is source=scan', scanned.source === 'scan')

  const off = await api('/api/marks/remove', {
    method: 'POST',
    body: { studentId: scanned.studentId, sessionId: session.id },
    cookie: admin,
  })
  check('unmarking a scanned student works', off.data.status === 'UNMARKED')
  const offAgain = await api('/api/marks/remove', {
    method: 'POST',
    body: { studentId: scanned.studentId, sessionId: session.id },
    cookie: admin,
  })
  check('unmarking twice is idempotent, not an error', offAgain.data.status === 'ALREADY_ABSENT')

  const on = await api('/api/marks', {
    method: 'POST',
    body: { sessionId: session.id, studentIds: [scanned.studentId], reason: 'phone dead' },
    cookie: admin,
  })
  check('marking by hand saves', on.data.status === 'SAVED' && on.data.saved === 1)
  const onAgain = await api('/api/marks', {
    method: 'POST',
    body: { sessionId: session.id, studentIds: [scanned.studentId] },
    cookie: admin,
  })
  check(
    'saving the same batch twice writes nothing new',
    onAgain.data.saved === 0 && onAgain.data.alreadyMarked === 1,
    JSON.stringify(onAgain.data)
  )
  check(
    'two audit entries were written for the unmark and the mark',
    (await count(
      'audit_log',
      `student_id=eq.${scanned.studentId}&action=in.(OVERRIDE_MARK,OVERRIDE_UNMARK)`
    )) === 2
  )
  check(
    'the reason given at save time is on the audit entry',
    (
      await one('audit_log', `select=reason&student_id=eq.${scanned.studentId}&order=id.desc&limit=1`)
    ).reason === 'phone dead'
  )
  check(
    'the mark is recorded as manual',
    (
      await one(
        'attendance',
        `select=source&session_id=eq.${session.id}&student_id=eq.${scanned.studentId}`
      )
    ).source === 'manual'
  )

  console.log('\n— a batch cannot be raced into the wrong state —')
  const raceStudent = roster.data.students[30]
  await api('/api/marks/remove', {
    method: 'POST',
    body: { sessionId: session.id, studentId: raceStudent.studentId },
    cookie: admin,
  })
  const doubled = await Promise.all(
    [1, 2, 3].map(() =>
      api('/api/marks', {
        method: 'POST',
        body: { sessionId: session.id, studentIds: [raceStudent.studentId] },
        cookie: admin,
      })
    )
  )
  check('three simultaneous saves all succeed', doubled.every((r) => r.status === 200))
  check(
    'and leave exactly one row — the old toggle would have flip-flopped',
    (await count(
      'attendance',
      `session_id=eq.${session.id}&student_id=eq.${raceStudent.studentId}`
    )) === 1
  )

  const batch = await api('/api/marks', {
    method: 'POST',
    body: {
      sessionId: session.id,
      studentIds: roster.data.students.slice(15, 25).map((s) => s.studentId),
      reason: 'late',
    },
    cookie: admin,
  })
  check('a batch of ten saves in one request', batch.data.saved === 10, JSON.stringify(batch.data))

  for (const [label, body] of [
    ['an empty batch', { sessionId: session.id, studentIds: [] }],
    ['a non-array', { sessionId: session.id, studentIds: 'nope' }],
    ['a junk id', { sessionId: session.id, studentIds: ['not-a-uuid'] }],
    ['an unknown session', { sessionId: uuid(), studentIds: [raceStudent.studentId] }],
    ['nobody on the roster', { sessionId: session.id, studentIds: [uuid()] }],
  ]) {
    const r = await api('/api/marks', { method: 'POST', body, cookie: admin })
    check(`${label} is refused`, r.status >= 400 && r.status < 500, `${r.status}`)
  }

  // ── a new phone must not cost the student their history ──────────────────
  //
  // This replaces the old "reset preserves attendance" case. There is no reset
  // any more: the point is that a student who turns up on a different phone
  // recovers by themselves and keeps everything.
  console.log('\n— a new phone keeps the history, and needs no admin —')
  const histStudent = roster.data.students[12]
  const histPhone = phone(BASE)
  await histPhone.register(session.id, tokenFor(secret, session.id, nowWindow()), histStudent.rollNo)
  const pastSession = await api('/api/sessions', {
    method: 'POST',
    body: { classDate: '2026-06-10' },
    cookie: admin,
  })
  await api('/api/marks', {
    method: 'POST',
    body: { sessionId: pastSession.data.session.id, studentIds: [histStudent.studentId] },
    cookie: admin,
  })
  const rowsBefore = await count('attendance', `student_id=eq.${histStudent.studentId}`)
  check('the student has history to lose', rowsBefore >= 2, `${rowsBefore} rows`)

  // A genuinely lost phone: keychain and session both gone.
  histPhone.wipe()
  const strandedRead = await histPhone.record()
  check('the lost phone can no longer read their record', strandedRead.status === 404)

  const replacement = phone(BASE)
  const recovered = await replacement.register(
    session.id,
    tokenFor(secret, session.id, nowWindow()),
    histStudent.rollNo
  )
  check(
    'a replacement phone registers itself, with no admin and no reset',
    recovered.data?.status === 'REGISTERED',
    JSON.stringify(recovered.data)
  )
  check(
    'attendance is untouched by the change of phone',
    (await count('attendance', `student_id=eq.${histStudent.studentId}`)) === rowsBefore,
    `${await count('attendance', `student_id=eq.${histStudent.studentId}`)} of ${rowsBefore}`
  )
  check(
    'the student now holds two credentials, the old one and the new',
    (await count('student_credentials', `student_id=eq.${histStudent.studentId}`)) === 2
  )
  const passkeyLog = await one(
    'audit_log',
    `select=reason,actor&action=eq.PASSKEY_REGISTERED&student_id=eq.${histStudent.studentId}&order=id.desc&limit=1`
  )
  check('registering a passkey is audited', passkeyLog !== undefined)
  check('and attributed to the student, not an admin', passkeyLog?.actor === 'student', String(passkeyLog?.actor))

  console.log('\n— the removed endpoints really are gone —')
  for (const [path, body] of [
    ['/api/reset-device', { studentId: histStudent.studentId }],
    ['/api/enroll', { s: session.id, t: 'x', rollNo: histStudent.rollNo }],
    ['/api/mark', { s: session.id, t: 'x' }],
    ['/api/admin/claim-device', {}],
    ['/api/enrollment', { open: true }],
  ]) {
    const gone = await api(path, { method: 'POST', body, cookie: admin })
    check(`${path} is gone`, gone.status === 404, `${gone.status}`)
  }

  // ── session controls the admin actually has ───────────────────────────────
  console.log('\n— extend, retune and stop —')

  const beforeExtend = new Date(
    (await one('sessions', `select=expires_at&id=eq.${session.id}`)).expires_at
  ).getTime()
  const extended = await api('/api/sessions/state', {
    method: 'POST',
    body: { sessionId: session.id, open: true, minutes: 10 },
    cookie: admin,
  })
  check('extending a live session succeeds', extended.status === 200)
  check('the extension is reported as an extension', extended.data.extended === true)
  const afterExtend = new Date(extended.data.session.expiresAt).getTime()
  check(
    'extension stacks on the existing end time, not on now',
    Math.abs(afterExtend - beforeExtend - 10 * 60_000) < 5_000,
    `moved ${Math.round((afterExtend - beforeExtend) / 60_000)} min`
  )

  const extendedTwice = await api('/api/sessions/state', {
    method: 'POST',
    body: { sessionId: session.id, open: true, minutes: 10 },
    cookie: admin,
  })
  check(
    'extending twice adds twice',
    Math.abs(new Date(extendedTwice.data.session.expiresAt).getTime() - afterExtend - 600_000) <
      5_000
  )

  const badExtend = await api('/api/sessions/state', {
    method: 'POST',
    body: { sessionId: session.id, open: true, minutes: 9999 },
    cookie: admin,
  })
  check('an absurd extension is refused', badExtend.data?.error === 'BAD_DURATION')

  // Retune the rotation on the running session.
  const retuned = await api('/api/sessions/state', {
    method: 'POST',
    body: { sessionId: session.id, open: true, windowSeconds: 60 },
    cookie: admin,
  })
  check('rotation can be changed mid-session', retuned.data.session?.windowSeconds === 60)
  const retunedToken = await api(`/api/token?s=${session.id}`, { cookie: admin })
  check('the token endpoint follows the new rotation', retunedToken.data.windowSeconds === 60)
  check(
    'retuning did not move the end time',
    Math.abs(
      new Date(retuned.data.session.expiresAt).getTime() -
        new Date(extendedTwice.data.session.expiresAt).getTime()
    ) < 2_000
  )

  await windowRoom(8000, 60)
  const at60 = await phoneC.markPresent(session.id, tokenFor(secret, session.id, nowWindow(60)))
  check(
    'a token minted at the new 60s period is accepted',
    at60.data?.status === 'MARKED',
    JSON.stringify(at60.data)
  )

  const at15 = await phoneC.markPresent(session.id, tokenFor(secret, session.id, nowWindow(15)))
  check(
    'a token minted at the old 15s period is now rejected',
    at15.data?.error === 'BAD_TOKEN',
    JSON.stringify(at15.data)
  )

  const badRetune = await api('/api/sessions/state', {
    method: 'POST',
    body: { sessionId: session.id, open: true, windowSeconds: 3 },
    cookie: admin,
  })
  check('an out-of-range rotation is refused', badRetune.data?.error === 'BAD_WINDOW')

  // Put it back to 15s so the remaining checks reason about one period.
  await api('/api/sessions/state', {
    method: 'POST',
    body: { sessionId: session.id, open: true, windowSeconds: 15 },
    cookie: admin,
  })

  // Stop early, then resume.
  const stopped = await api('/api/sessions/state', {
    method: 'POST',
    body: { sessionId: session.id, open: false },
    cookie: admin,
  })
  check('stopping the session succeeds', stopped.status === 200)
  check('a stopped session is not scannable', stopped.data.session.scannable === false)
  check(
    'stopping pulls the end time back to now, so the countdown is honest',
    Math.abs(new Date(stopped.data.session.expiresAt).getTime() - Date.now()) < 10_000
  )
  const stoppedToken = await api(`/api/token?s=${session.id}`, { cookie: admin })
  check('no token is issued once stopped', stoppedToken.status === 409)
  const stoppedMark = await phoneC.markPresent(session.id, tokenFor(secret, session.id, nowWindow()))
  check('scanning a stopped session is refused', stoppedMark.data?.error === 'SESSION_CLOSED')

  const resumed = await api('/api/sessions/state', {
    method: 'POST',
    body: { sessionId: session.id, open: true, minutes: 20 },
    cookie: admin,
  })
  check('resuming a stopped session succeeds', resumed.data.session.scannable === true)
  check('a resume is not reported as an extension', resumed.data.extended === false)
  check(
    'resume measures from now',
    Math.abs(new Date(resumed.data.session.expiresAt).getTime() - Date.now() - 20 * 60_000) <
      10_000
  )

  // ── the instructor is one of the 47 ───────────────────────────────────────
  console.log('\n— instructor is also a student —')
  const selfRoster = await api(`/api/roster?s=${session.id}`, { cookie: admin })
  const selfRows = selfRoster.data.students.filter((s) => s.isSelf)
  if (process.env.ADMIN_ROLL_NO) {
    check('exactly one row is flagged as the instructor', selfRows.length === 1, `${selfRows.length}`)
    check(
      'it is the roll number ADMIN_ROLL_NO names',
      selfRows[0]?.rollNo === process.env.ADMIN_ROLL_NO
    )
    const selfToggle = await api('/api/marks', {
      method: 'POST',
      body: { sessionId: session.id, studentIds: [selfRows[0].studentId] },
      cookie: admin,
    })
    check('the admin can mark their own attendance', selfToggle.status === 200)
    await api('/api/marks/remove', {
      method: 'POST',
      body: { sessionId: session.id, studentId: selfRows[0].studentId },
      cookie: admin,
    })
  } else {
    check('no row is flagged when ADMIN_ROLL_NO is unset', selfRows.length === 0)
  }

  // ── expiry ────────────────────────────────────────────────────────────────
  console.log('\n— expired and closed sessions —')
  await patch('sessions', `id=eq.${session.id}`, {
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  })
  t = tokenFor(secret, session.id, nowWindow())
  const expired = await phoneC.markPresent(session.id, t)
  check('expired session → SESSION_CLOSED, not a stack trace', expired.status === 409 && expired.data.error === 'SESSION_CLOSED')
  const expiredToken = await api(`/api/token?s=${session.id}`, { cookie: admin })
  check('no token is issued for an expired session', expiredToken.status === 409)
  const stillTaps = await api('/api/marks', {
    method: 'POST',
    body: { sessionId: session.id, studentIds: [scanned.studentId] },
    cookie: admin,
  })
  check('the admin can still mark on an expired session', stillTaps.status === 200)

  const missing = await phoneC.markPresent(uuid(), t)
  check('unknown session id → SESSION_CLOSED', missing.data.error === 'SESSION_CLOSED')

  // ── backdated sessions ────────────────────────────────────────────────────
  console.log('\n— backdated sessions —')
  const past = '2026-08-14'
  const back = await api('/api/sessions', { method: 'POST', body: { classDate: past }, cookie: admin })
  check('backdated session is created', back.status === 201, JSON.stringify(back.data))
  const backSession = back.data.session
  check('backdated session is not open', backSession.isOpen === false && backSession.scannable === false)

  const backToken = await api(`/api/token?s=${backSession.id}`, { cookie: admin })
  check('no QR token is ever generated for a backdated session', backToken.status === 409)

  const backRoster = await api(`/api/roster?s=${backSession.id}`, { cookie: admin })
  check('the backdated grid loads with every student', backRoster.data.students.length === studentCount)
  check('the backdated grid starts empty', backRoster.data.markedCount === 0)

  const backTap = await api('/api/marks', {
    method: 'POST',
    body: { sessionId: backSession.id, studentIds: [backRoster.data.students[5].studentId] },
    cookie: admin,
  })
  check('marks save on a backdated session', backTap.data.saved === 1)

  const dupe = await api('/api/sessions', { method: 'POST', body: { classDate: past }, cookie: admin })
  check(
    'a second session for the same date is refused',
    dupe.status === 409 && dupe.data.error === 'DATE_HAS_SESSION',
    JSON.stringify(dupe.data)
  )
  check('...and the existing one is offered instead', dupe.data.session?.id === backSession.id)

  const dupeToday = await api('/api/sessions', { method: 'POST', body: {}, cookie: admin })
  check("today's session is likewise offered, not duplicated", dupeToday.data.session?.id === session.id)

  const future = await api('/api/sessions', {
    method: 'POST',
    body: { classDate: '2099-01-01' },
    cookie: admin,
  })
  check('a future date is refused', future.data.error === 'FUTURE_DATE')

  const badDate = await api('/api/sessions', {
    method: 'POST',
    body: { classDate: '2026-02-31' },
    cookie: admin,
  })
  check('an impossible date is refused', badDate.data.error === 'BAD_DATE')

  const reopenPast = await api('/api/sessions/state', {
    method: 'POST',
    body: { sessionId: backSession.id, open: true },
    cookie: admin,
  })
  check('a past session cannot be made scannable', reopenPast.data.error === 'NOT_TODAY')

  // ── export ────────────────────────────────────────────────────────────────
  console.log('\n— export —')
  const exportRes = await fetch(`${BASE}/api/export`, { headers: { cookie: admin } })
  const buf = Buffer.from(await exportRes.arrayBuffer())
  check('export returns an xlsx', exportRes.status === 200 && buf.subarray(0, 2).toString() === 'PK')
  check(
    'export is served as a spreadsheet attachment',
    (exportRes.headers.get('content-disposition') ?? '').includes('.xlsx')
  )

  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(buf)
  const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string')
  const shared = await zip.file('xl/sharedStrings.xml').async('string')

  check('V holds a live COUNTIF formula', sheet.includes('COUNTIF(F2:U2,'))
  check('W holds a live percentage formula', sheet.includes('COUNT($F$1:$U$1)=0'))
  check('class dates are written as Excel serials', /<c r="F1"[^>]*><v>4\d{4}<\/v>/.test(sheet))
  check('headers keep the original spelling', shared.includes('Attendnacs'))
  check('the trailing space in "Name " survives', shared.includes('<t xml:space="preserve">Name </t>'))
  const ticks = (sheet.match(/>✓</g) ?? []).length + (shared.match(/>✓</g) ?? []).length
  check('the export contains ✓ marks', ticks > 0)
  check('the export never writes ✎ — manual and scanned look identical', !sheet.includes('✎') && !shared.includes('✎'))

  // Their own export needs the passkey session, exactly as /me does — and
  // phoneB is the phone that holds rollB's passkey.
  const meExport = await fetch(`${BASE}/api/me/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: phoneB.cookie ?? '' },
    body: JSON.stringify({}),
  })
  check('the student export needs a session', meExport.status === 200, `HTTP ${meExport.status}`)
  const meBuf = Buffer.from(await meExport.arrayBuffer())
  const meZip = await JSZip.loadAsync(meBuf)
  const meShared = await meZip.file('xl/sharedStrings.xml').async('string')
  check('a student can export their own single row', meExport.status === 200)
  check('the student export contains their roll number', meShared.includes(rollB))
  check(
    'the student export contains nobody else',
    !meShared.includes(rollA) && !meShared.includes(rollC)
  )

  // ── adding a student mid-term ─────────────────────────────────────────────
  console.log('\n— adding a student —')

  for (const [label, body] of [
    ['no name', { rollNo: 'MT2026901' }],
    ['no roll number', { name: 'Asha Menon' }],
    ['a blank name', { rollNo: 'MT2026901', name: '   ' }],
    ['a wildcard in the roll number', { rollNo: 'MT20269%1', name: 'Asha Menon' }],
    ['a space in the roll number', { rollNo: 'MT 2026901', name: 'Asha Menon' }],
    ['a 300-character name', { rollNo: 'MT2026901', name: 'x'.repeat(300) }],
    ['a malformed email', { rollNo: 'MT2026901', name: 'Asha Menon', email: 'not-an-email' }],
  ]) {
    const r = await api('/api/students', { method: 'POST', body, cookie: admin })
    check(`${label} is refused`, r.status >= 400 && r.status < 500, `${r.status} ${JSON.stringify(r.data)}`)
  }

  const before = await count('students')
  const added = await api('/api/students', {
    method: 'POST',
    body: { rollNo: 'MT2026901', name: 'Asha Menon', email: 'asha.menon@iiitb.ac.in' },
    cookie: admin,
  })
  check('adding a student succeeds', added.status === 201, JSON.stringify(added.data))
  const newStudent = added.data.student
  check(
    'they take the next sheet position, not somebody else\'s',
    newStudent.sNo === before + 1,
    `s_no ${newStudent.sNo} with ${before} students before`
  )
  check('the roster grew by one', (await count('students')) === before + 1)

  const dupe2 = await api('/api/students', {
    method: 'POST',
    body: { rollNo: 'mt2026901', name: 'Someone Else' },
    cookie: admin,
  })
  check(
    'the same roll number in another case is refused',
    dupe2.status === 409 && dupe2.data.error === 'ROLL_TAKEN',
    JSON.stringify(dupe2.data)
  )

  // The cached roster must not hide them from the very next request.
  const grewRoster = await api(`/api/roster?s=${session.id}`, { cookie: admin })
  check(
    'they appear in the roster immediately — the cache was invalidated',
    grewRoster.data.students.some((s) => s.rollNo === 'MT2026901'),
    `${grewRoster.data.total} students returned`
  )
  check('and the roster total reflects them', grewRoster.data.total === before + 1)

  const markNew = await api('/api/marks', {
    method: 'POST',
    body: { sessionId: session.id, studentIds: [newStudent.studentId] },
    cookie: admin,
  })
  check('a newly added student can be marked', markNew.data?.saved === 1, JSON.stringify(markNew.data))

  const exportWithNew = await fetch(`${BASE}/api/export`, { headers: { cookie: admin } })
  const newBuf = Buffer.from(await exportWithNew.arrayBuffer())
  const { default: JSZipNew } = await import('jszip')
  const zipNew = await JSZipNew.loadAsync(newBuf)
  const sharedNew = await zipNew.file('xl/sharedStrings.xml').async('string')
  check('they appear in the exported sheet', sharedNew.includes('MT2026901'))
  check('and their name is there', sharedNew.includes('Asha Menon'))

  const deputyAdd = await api('/api/students', {
    method: 'POST',
    body: { rollNo: 'MT2026902', name: 'Not Allowed' },
    cookie: admin,
  })
  check('the admin may add a second one', deputyAdd.status === 201)

  check(
    'each addition is audited',
    (await count('audit_log', 'action=eq.ADD_STUDENT')) === 2,
    `${await count('audit_log', 'action=eq.ADD_STUDENT')} entries`
  )

  // Leave the roster as it was found.
  await remove('students', 'roll_no=in.(MT2026901,MT2026902)')
  check('the test cleans up after itself', (await count('students')) === before)

  // ── date-range export ─────────────────────────────────────────────────────
  console.log('\n— export by date range —')

  const allDates = (await select('sessions', 'select=class_date&order=class_date.asc')).map(
    (r) => r.class_date
  )
  const totalClasses = allDates.length
  check('there are classes to slice between', totalClasses >= 2, JSON.stringify(allDates))

  async function exportWith(qs, cookie = admin) {
    const res = await fetch(`${BASE}/api/export${qs}`, { headers: { cookie } })
    const buf = Buffer.from(await res.arrayBuffer())
    return {
      status: res.status,
      classes: Number(res.headers.get('x-export-classes') ?? '-1'),
      viewOnly: res.headers.get('x-export-view-only') === '1',
      filename: /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? '',
      buf,
    }
  }

  const whole = await exportWith('')
  check('no range exports every class', whole.classes === totalClasses, `${whole.classes} of ${totalClasses}`)

  const onlyLatest = await exportWith(`?from=${allDates[totalClasses - 1]}`)
  check('from= drops earlier classes', onlyLatest.classes === 1, `${onlyLatest.classes}`)

  const onlyEarliest = await exportWith(`?to=${allDates[0]}`)
  check('to= drops later classes', onlyEarliest.classes === 1, `${onlyEarliest.classes}`)

  const exact = await exportWith(`?from=${allDates[0]}&to=${allDates[totalClasses - 1]}`)
  check('a range covering all of them keeps all', exact.classes === totalClasses, `${exact.classes}`)

  const empty = await exportWith('?from=1990-01-01&to=1990-12-31')
  check('a range with no classes still builds a file', empty.status === 200 && empty.classes === 0)

  check(
    'the filename records the range',
    onlyLatest.filename.includes(allDates[totalClasses - 1]),
    onlyLatest.filename
  )

  const badRange = await api(`/api/export?from=${allDates[totalClasses - 1]}&to=${allDates[0]}`, { cookie: admin })
  check('a backwards range is refused', badRange.data?.error === 'BAD_RANGE')
  const badExportDate = await api('/api/export?from=not-a-date', { cookie: admin })
  check('a malformed date is refused', badExportDate.data?.error === 'BAD_DATE')

  check(
    "the instructor's own copy is not locked",
    !(await (async () => {
      const { default: JSZip } = await import('jszip')
      const z = await JSZip.loadAsync(whole.buf)
      return (await z.file('xl/worksheets/sheet1.xml').async('string')).includes('sheetProtection')
    })())
  )

  const exportAudit = await select(
    'audit_log',
    'select=actor,reason&action=eq.EXPORT&order=id.desc'
  )
  check('every export is logged server-side', exportAudit.length >= 6, `${exportAudit.length}`)
  check('the log names the instructor as actor', exportAudit.every((r) => r.actor === 'primary'))

  // ── temporary access ──────────────────────────────────────────────────────
  console.log('\n— temporary admin access —')

  const noStudent = await api('/api/grants', { method: 'POST', body: { hours: 4 }, cookie: admin })
  check('a grant without a student is refused', noStudent.data?.error === 'MISSING_STUDENT')
  const ghostStudent = await api('/api/grants', {
    method: 'POST',
    body: { studentId: uuid(), hours: 4 },
    cookie: admin,
  })
  check(
    'a grant for someone not on the roster is refused',
    ghostStudent.data?.error === 'UNKNOWN_STUDENT',
    JSON.stringify(ghostStudent.data)
  )
  for (const hours of [0, 0.5, 24 * 8, 'four']) {
    const r = await api('/api/grants', {
      method: 'POST',
      body: { studentId: students[0].id, hours },
      cookie: admin,
    })
    check(`hours=${hours} is refused`, r.data?.error === 'BAD_HOURS', JSON.stringify(r.data))
  }

  const issuedRes = await api('/api/grants', {
    method: 'POST',
    body: { studentId: students[4].id, hours: 4 },
    cookie: admin,
  })
  check('issuing temporary access succeeds', issuedRes.status === 201, JSON.stringify(issuedRes.data))
  const code = issuedRes.data.code
  check('a code is returned once', typeof code === 'string' && /^[2-9A-Z]{4}(-[2-9A-Z]{4}){2}$/.test(code), code)
  const grantId = issuedRes.data.grant.id

  const storedGrant = await one('admin_grants', `select=code_hash,label&id=eq.${grantId}`)
  check('only a hash of the code is stored', storedGrant.code_hash.length === 64)
  check(
    'the plaintext code is nowhere in the row',
    !JSON.stringify(storedGrant).includes(code.replace(/-/g, ''))
  )

  const listed = await api('/api/grants', { cookie: admin })
  check('the grant is listed as active', listed.data.grants.some((g) => g.id === grantId && g.active))
  check(
    'listing never returns codes',
    !JSON.stringify(listed.data).includes(code.replace(/-/g, ''))
  )

  // Sign in as the deputy.
  const deputyLogin = await api('/api/admin/login', { method: 'POST', body: { password: code } })
  check('the code signs in', deputyLogin.status === 200 && deputyLogin.data.role === 'deputy')
  const expectedLabel = `${students[4].name.trim()} (${students[4].roll_no})`
  check(
    'the deputy is named back, derived from the roster',
    deputyLogin.data.label === expectedLabel,
    `${deputyLogin.data.label} vs ${expectedLabel}`
  )
  const deputy = (deputyLogin.res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .join('; ')
  check('a deputy cookie is set', deputy.includes('att_admin'))

  const who = await api('/api/whoami', { cookie: deputy })
  check('whoami reports the deputy role', who.data?.role === 'deputy')

  // What a deputy MAY do: run the class.
  console.log('\n  deputy can run the class:')
  const dRoster = await api(`/api/roster?s=${session.id}`, { cookie: deputy })
  check('deputy reads the roster', dRoster.status === 200 && dRoster.data.students.length === studentCount)
  check('the roster tells the UI they are a deputy', dRoster.data.role === 'deputy')
  // The session is expired at this point (the expiry block above pulled it back),
  // so the honest sequence is: refused while lapsed, then revived, then allowed.
  const dTokenExpired = await api(`/api/token?s=${session.id}`, { cookie: deputy })
  check(
    'deputy gets no token while the session is lapsed',
    dTokenExpired.status === 409,
    `got ${dTokenExpired.status}`
  )
  const dRevive = await api('/api/sessions/state', {
    method: 'POST',
    body: { sessionId: session.id, open: true, minutes: 10 },
    cookie: deputy,
  })
  check('deputy can revive a lapsed session', dRevive.status === 200, JSON.stringify(dRevive.data))
  const dToken = await api(`/api/token?s=${session.id}`, { cookie: deputy })
  check(
    'deputy can generate the QR token once it is live',
    dToken.status === 200,
    `got ${dToken.status} ${JSON.stringify(dToken.data)}`
  )
  check('the token carries the session rotation', dToken.data?.windowSeconds === 15)
  const dToggle = await api('/api/marks', {
    method: 'POST',
    body: {
      sessionId: session.id,
      studentIds: [dRoster.data.students[8].studentId],
      reason: 'late',
    },
    cookie: deputy,
  })
  check('deputy can mark attendance', dToggle.status === 200 && dToggle.data.saved === 1)
  const dExtend = await api('/api/sessions/state', {
    method: 'POST',
    body: { sessionId: session.id, open: true, minutes: 5 },
    cookie: deputy,
  })
  check('deputy can extend the session', dExtend.status === 200)
  check('and it counts as an extension, not a resume', dExtend.data?.extended === true)
  const dStart = await api('/api/sessions', {
    method: 'POST',
    body: { classDate: '2026-08-13', durationMinutes: 30, windowSeconds: 15 },
    cookie: deputy,
  })
  check('deputy can start a session', dStart.status === 201, JSON.stringify(dStart.data))

  check(
    'the log attributes the deputy by name',
    (await select('audit_log', `select=actor&actor=eq.deputy:${encodeURIComponent(expectedLabel)}`))
      .length >= 3
  )

  // What a deputy MAY NOT do: anything touching identity.
  console.log('\n  deputy is refused identity operations:')
  for (const [path, body] of [
    ['/api/grants', { label: 'onward', hours: 2 }],
    ['/api/students', { rollNo: 'MT2026903', name: 'Deputy Added' }],
    ['/api/grants/revoke', { grantId }],
  ]) {
    const r = await api(path, { method: 'POST', body, cookie: deputy })
    check(`POST ${path} → 403 for a deputy`, r.status === 403, `got ${r.status}`)
  }
  const dGrantsList = await api('/api/grants', { cookie: deputy })
  check('GET /api/grants → 403 for a deputy', dGrantsList.status === 403)

  // Their spreadsheet is view-only and stamped.
  console.log('\n  deputy exports are view-only:')
  const dExport = await exportWith('', deputy)
  check('deputy export succeeds', dExport.status === 200)
  check('it is flagged view-only', dExport.viewOnly === true)
  check('the filename says so', dExport.filename.includes('view-only'), dExport.filename)
  const { default: JSZip2 } = await import('jszip')
  const dZip = await JSZip2.loadAsync(dExport.buf)
  const dSheet = await dZip.file('xl/worksheets/sheet1.xml').async('string')
  const dCore = await dZip.file('docProps/core.xml').async('string')
  const dShared = await dZip.file('xl/sharedStrings.xml').async('string')
  check('the sheet is protected', dSheet.includes('<sheetProtection'))
  check('formulas still recalculate', dSheet.includes('COUNTIF(F2:U2'))
  check('a second sheet names the recipient', dShared.includes(students[4].name.trim()))
  check('metadata carries the provenance', dCore.includes(students[4].name.trim()))
  check(
    'deputy exports are logged against them',
    (
      await select(
        'audit_log',
        `select=actor&action=eq.EXPORT&actor=eq.deputy:${encodeURIComponent(expectedLabel)}`
      )
    ).length >= 1
  )

  // Revocation is immediate.
  console.log('\n  revocation:')
  const revoked = await api('/api/grants/revoke', {
    method: 'POST',
    body: { grantId },
    cookie: admin,
  })
  check('the instructor can revoke', revoked.status === 200)
  const afterRevoke = await api(`/api/roster?s=${session.id}`, { cookie: deputy })
  check(
    'the deputy cookie stops working immediately',
    afterRevoke.status === 401,
    `got ${afterRevoke.status}`
  )
  const reuse = await api('/api/admin/login', { method: 'POST', body: { password: code } })
  check('a revoked code cannot sign in again', reuse.data?.error === 'CODE_REVOKED')
  const doubleRevoke = await api('/api/grants/revoke', {
    method: 'POST',
    body: { grantId },
    cookie: admin,
  })
  check('revoking twice is a no-op, not an error path', doubleRevoke.status === 404)

  // An expired grant is refused at the door.
  const expiring = await api('/api/grants', {
    method: 'POST',
    body: { studentId: students[6].id, hours: 1 },
    cookie: admin,
  })
  await patch('admin_grants', `id=eq.${expiring.data.grant.id}`, {
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  })
  const expiredLogin = await api('/api/admin/login', {
    method: 'POST',
    body: { password: expiring.data.code },
  })
  check('an expired code is refused', expiredLogin.data?.error === 'CODE_EXPIRED')

  const forgedCode = await api('/api/admin/login', {
    method: 'POST',
    body: { password: 'ZZZZ-ZZZZ-ZZZZ' },
  })
  check('an invented code is refused', forgedCode.data?.error === 'BAD_PASSWORD')

  check(
    'the instructor still has full access throughout',
    (await api('/api/grants', { cookie: admin })).status === 200
  )

  // ── pages render ──────────────────────────────────────────────────────────
  console.log('\n— pages —')
  for (const [path, expect] of [
    ['/', 'Soft Skills Attendance'],
    ['/me', 'Soft Skills Attendance'],
    [`/m?s=${session.id}&t=${t}`, 'Soft Skills Attendance'],
    ['/admin', 'Admin sign-in'],
  ]) {
    const res = await fetch(BASE + path)
    const html = await res.text()
    check(`GET ${path} renders`, res.status === 200 && html.includes(expect), `status ${res.status}`)
  }
  const adminHtml = await (await fetch(`${BASE}/admin`, { headers: { cookie: admin } })).text()
  check('/admin with the cookie renders the grid, not the login', !adminHtml.includes('Admin sign-in'))

  const forgedCookie = await api('/api/roster', { cookie: 'att_admin=9999999999.forged' })
  check('a forged admin cookie is rejected', forgedCookie.status === 401)

  console.log(`\n${'='.repeat(60)}`)
  console.log(`${pass} passed, ${fail} failed`)
  if (failures.length) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  console.log('='.repeat(60))
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nharness crashed:', e)
  process.exit(1)
})
