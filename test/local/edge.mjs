/**
 * Real-world edge cases: hostile input, races, boundaries, and the failure modes
 * a classroom actually produces. Includes regressions for bugs found by probing.
 *
 *   set -a; . ./.env.local; set +a
 *   node test/local/edge.mjs
 */
import { createHmac } from 'node:crypto'
import { count, insert, one, patch, remove, resetToRoster, select } from './db.mjs'
import { phone } from './student.mjs'

// localhost, not 127.0.0.1: WebAuthn will not accept an IP address as a
// Relying Party ID, so a passkey cannot be created on 127.0.0.1 at all.
const BASE = process.env.BASE_URL ?? 'http://localhost:3100'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
const WINDOW = 15

let pass = 0
let fail = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ` - ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`)
  }
}

const uuid = () => crypto.randomUUID()
const tokenFor = (secret, sid, w) =>
  createHmac('sha256', secret).update(`${sid}:${w}`).digest('base64url').slice(0, 12)
const nowWindow = (p = WINDOW) => Math.floor(Date.now() / 1000 / p)

async function api(path, { method = 'GET', body, cookie, raw } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  })
  const type = res.headers.get('content-type') ?? ''
  return {
    status: res.status,
    data: type.includes('json') ? await res.json().catch(() => ({})) : null,
    res,
  }
}

const cookieOf = (res) =>
  (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')

async function main() {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD not set')

  // Failed sign-ins now persist in a table, so a previous run's brute-force
  // test would throttle this one out of its own login.
  await remove('login_attempts', 'id=gt.0')
  await remove('admin_grants', 'id=not.is.null')
  await resetToRoster()

  const login = await api('/api/admin/login', {
    method: 'POST',
    body: { password: ADMIN_PASSWORD },
  })
  let admin = cookieOf(login.res)

  const made = await api('/api/sessions', {
    method: 'POST',
    body: { durationMinutes: 120, windowSeconds: 15 },
    cookie: admin,
  })
  const session = made.data.session
  const secret = (await one('sessions', `select=secret&id=eq.${session.id}`)).secret
  const tok = () => tokenFor(secret, session.id, nowWindow())
  const students = await select('students', 'select=id,roll_no,name&order=s_no.asc')
  const rollOf = (i) => students[i].roll_no

  // -- regression: LIKE wildcards in a roll number ---------------------------
  console.log('\n- roll number is matched exactly (regression) -')
  for (const probe of ['MT202652_', '%', 'MT%', '_T2026520', 'MT20265%0', '%%%', 'MT_026520']) {
    const r = await phone(BASE).register(session.id, tok(), probe)
    check(
      `"${probe}" cannot claim anyone`,
      r.status === 404 && r.data.error === 'UNKNOWN_ROLL',
      `${r.status} ${JSON.stringify(r.data)}`
    )
  }
  check('nobody got claimed by a wildcard', (await count('student_credentials')) === 0)

  console.log('\n- roll number tolerance for honest typing -')
  const phoneOne = phone(BASE)
  const lower = await phoneOne.register(session.id, tok(), rollOf(0).toLowerCase())
  check('lowercase roll number is accepted', lower.data?.status === 'REGISTERED', JSON.stringify(lower.data))

  const spaced = await phone(BASE).register(session.id, tok(), `  ${rollOf(1)}  `)
  check('surrounding whitespace is trimmed', spaced.data?.status === 'REGISTERED')

  for (const [label, rollNo] of [
    ['an empty roll number', ''],
    ['whitespace only', '   '],
    ['a 500-character roll number', 'M'.repeat(500)],
    ['an unrelated roll number', 'XX9999999'],
  ]) {
    const r = await phone(BASE).register(session.id, tok(), rollNo)
    check(`${label} is refused cleanly`, r.status < 500 && Boolean(r.data?.error), `${r.status}`)
  }
  for (const bad of [42, null, {}, [], true]) {
    const r = await api('/api/passkey/register/options', {
      method: 'POST',
      body: { s: session.id, t: tok(), rollNo: bad },
    })
    check(`a ${typeof bad} roll number does not crash`, r.status < 500, `${r.status}`)
  }

  // -- what one phone can and cannot do -------------------------------------
  //
  // Device binding enforced "one phone, one student" with a unique column. A
  // passkey is not a device, so that constraint is gone — and it turns out the
  // useful half survives anyway: a credential belongs to exactly one student,
  // so a phone that signs in is always the student it registered as. What it
  // can now do, deliberately, is hold a second passkey for a second student —
  // a shared family phone, or the admin's own phone.
  console.log('\n- one phone, more than one passkey -')
  // Same phone, same student, twice: refused by the authenticator itself, not
  // by us. The server puts that student's existing credentials in
  // excludeCredentials, and a platform authenticator throws InvalidStateError
  // rather than making a second one. Verified against a real virtual
  // authenticator, so the software one here honours it too.
  const dupe = await phoneOne.register(session.id, tok(), rollOf(0))
  check(
    'the same phone cannot register the same student twice',
    dupe.data?.error === 'InvalidStateError',
    JSON.stringify(dupe.data)
  )
  check(
    'and no duplicate credential was written',
    (await count('student_credentials', `student_id=eq.${students[0].id}`)) === 1
  )

  const secondStudent = await phoneOne.register(session.id, tok(), rollOf(2))
  check(
    'one phone may register a second student',
    secondStudent.data?.status === 'REGISTERED',
    JSON.stringify(secondStudent.data)
  )
  check(
    'each passkey belongs to exactly one student',
    (await count('student_credentials')) === 3
  )
  // The authenticator offers the most recent resident credential, so signing in
  // marks whoever it last registered — never an arbitrary student.
  const whoAmI = await phoneOne.markPresent(session.id, tok())
  check(
    'signing in marks the student that passkey belongs to',
    whoAmI.data?.rollNo === rollOf(2),
    JSON.stringify(whoAmI.data)
  )

  console.log('\n- a malformed assertion is refused, never crashes -')
  for (const [label, response] of [
    ['a missing response', undefined],
    ['an empty object', {}],
    ['a response with no id', { response: {} }],
    ['a string', 'not-an-assertion'],
    ['a number', 7],
    ['an id that is not registered', { id: 'AAAAAAAAAAAAAAAAAAAAAA', response: {} }],
  ]) {
    const opts = await api('/api/passkey/auth/options', {
      method: 'POST',
      body: { s: session.id, t: tok() },
    })
    const r = await api('/api/passkey/auth/verify', {
      method: 'POST',
      body: { s: session.id, t: tok(), challenge: opts.data?.options?.challenge, response },
    })
    check(`${label} is refused cleanly`, r.status >= 400 && r.status < 500, `${r.status}`)
  }

  console.log('\n- two phones race for the same roll number -')
  //
  // Exactly one may win. Checking for an existing credential and then inserting
  // one is two statements, and three simultaneous claims all passed the check
  // before any of them wrote — two credentials landed. The claim is now a
  // guarded update on students.passkey_claimed, so Postgres picks the winner.
  const raceRoll = rollOf(5)
  const raced = await Promise.all([phone(BASE), phone(BASE), phone(BASE)].map((p) =>
    p.register(session.id, tok(), raceRoll)
  ))
  const won = raced.filter((r) => r.data?.status === 'REGISTERED').length
  check('exactly one phone wins the claim', won === 1, `${won} succeeded`)
  check(
    'the losers are queued for approval, not silently dropped',
    raced.filter((r) => r.data?.error === 'NEEDS_APPROVAL').length === 2,
    JSON.stringify(raced.map((r) => r.data?.status ?? r.data?.error))
  )
  // One pending row per student, so a single roll number cannot flood the queue.
  check('at most one request is kept for that student', (await count('passkey_requests')) === 1)
  const raceStudent = students.find((r) => r.roll_no === raceRoll)
  check(
    'one credential, not two',
    (await count('student_credentials', `student_id=eq.${raceStudent.id}`)) === 1
  )
  check(
    'and exactly one attendance row for them',
    (await count('attendance', `session_id=eq.${session.id}&student_id=eq.${raceStudent.id}`)) === 1
  )

  // -- tokens ---------------------------------------------------------------
  console.log('\n- token rejection -')
  const unicodeToken = '✓'.repeat(12)
  for (const [label, t] of [
    ['a missing token', undefined],
    ['an empty token', ''],
    ['an 11-char token', 'a'.repeat(11)],
    ['a 13-char token', 'a'.repeat(13)],
    ['a token with base64 padding chars', 'abc/def+ghi='],
    ['a unicode token', unicodeToken],
    ['a token for another session', tokenFor(secret, uuid(), nowWindow())],
    ['a token signed with another secret', tokenFor('deadbeef', session.id, nowWindow())],
  ]) {
    const r = await phoneOne.markPresent(session.id, t)
    check(`${label} is rejected`, r.data?.error === 'BAD_TOKEN', JSON.stringify(r.data))
  }

  // -- session boundaries ---------------------------------------------------
  console.log('\n- session boundaries -')
  await patch('sessions', `id=eq.${session.id}`, {
    expires_at: new Date(Date.now() - 1).toISOString(),
  })
  const atBoundary = await phoneOne.markPresent(session.id, tok())
  check('expires_at in the past closes the session', atBoundary.data?.error === 'SESSION_CLOSED')
  await api('/api/sessions/state', {
    method: 'POST',
    body: { sessionId: session.id, open: true, minutes: 60 },
    cookie: admin,
  })

  console.log('\n- a class that runs past midnight (regression) -')
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  await patch('sessions', `id=eq.${session.id}`, {
    class_date: yesterday,
    is_open: true,
    expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
  })
  const liveRoster = await api(`/api/roster?s=${session.id}`, { cookie: admin })
  check('the session is still live after the date rolls over', liveRoster.data.session.scannable === true)
  const midnightExtend = await api('/api/sessions/state', {
    method: 'POST',
    body: { sessionId: session.id, open: true, minutes: 15 },
    cookie: admin,
  })
  check(
    'a live session can still be extended past midnight',
    midnightExtend.status === 200 && midnightExtend.data.extended === true,
    JSON.stringify(midnightExtend.data)
  )
  const midnightScan = await phoneOne.markPresent(session.id, tok())
  check('students can still scan past midnight', midnightScan.data?.status === 'MARKED')

  // The protection this must not lose.
  await patch('sessions', `id=eq.${session.id}`, {
    is_open: false,
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  })
  const lapsedPast = await api('/api/sessions/state', {
    method: 'POST',
    body: { sessionId: session.id, open: true, minutes: 10 },
    cookie: admin,
  })
  check(
    'a lapsed session on a past date still cannot be reopened',
    lapsedPast.data?.error === 'NOT_TODAY',
    JSON.stringify(lapsedPast.data)
  )
  const today = (await api('/api/sessions', { cookie: admin })).data.today
  await patch('sessions', `id=eq.${session.id}`, {
    class_date: today,
    is_open: true,
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  })

  console.log('\n- two admins start the same date at once -')
  await remove('sessions', 'class_date=eq.2026-07-01')
  const dueled = await Promise.all(
    [1, 2, 3].map(() =>
      api('/api/sessions', { method: 'POST', body: { classDate: '2026-07-01' }, cookie: admin })
    )
  )
  check('exactly one session is created', dueled.filter((r) => r.status === 201).length === 1)
  check(
    'the others are handed the existing one',
    dueled.filter((r) => r.data?.error === 'DATE_HAS_SESSION' && r.data.session).length === 2
  )
  check('only one row exists for that date', (await count('sessions', 'class_date=eq.2026-07-01')) === 1)

  // -- concurrent scan and manual toggle on one student ---------------------
  console.log('\n- a scan and an admin tap collide -')
  await remove('attendance', `session_id=eq.${session.id}`)
  const target = students.find((s) => s.roll_no === rollOf(0))
  const collide = await Promise.all([
    phoneOne.markPresent(session.id, tok()),
    api('/api/marks', {
      method: 'POST',
      body: { sessionId: session.id, studentIds: [target.id] },
      cookie: admin,
    }),
  ])
  check(
    'neither request errors',
    collide.every((r) => r.status < 500),
    JSON.stringify(collide.map((r) => r.status))
  )
  const rows = await count(
    'attendance',
    `session_id=eq.${session.id}&student_id=eq.${target.id}`
  )
  check('the student ends up with 0 or 1 rows, never a duplicate', rows <= 1, `${rows}`)

  console.log('\n- toggling things that do not exist -')
  const noStudent = await api('/api/marks', {
    method: 'POST',
    body: { sessionId: session.id, studentIds: [uuid()] },
    cookie: admin,
  })
  check('unknown student gives NO_STUDENT', noStudent.data?.error === 'NO_STUDENT')
  const noSession = await api('/api/marks', {
    method: 'POST',
    body: { sessionId: uuid(), studentIds: [target.id] },
    cookie: admin,
  })
  check('unknown session gives NO_SESSION', noSession.data?.error === 'NO_SESSION')

  // -- malformed requests ---------------------------------------------------
  console.log('\n- malformed and hostile bodies -')
  const brokenJson = await api('/api/passkey/auth/options', { method: 'POST', raw: '{"s": "abc",' })
  check('truncated JSON gives 4xx, not 500', brokenJson.status >= 400 && brokenJson.status < 500, `${brokenJson.status}`)
  const emptyBody = await api('/api/passkey/auth/options', { method: 'POST', raw: '' })
  check('an empty body gives 4xx', emptyBody.status >= 400 && emptyBody.status < 500, `${emptyBody.status}`)
  const arrayBody = await api('/api/marks', { method: 'POST', raw: '[1,2,3]', cookie: admin })
  check('a JSON array body gives 4xx', arrayBody.status >= 400 && arrayBody.status < 500, `${arrayBody.status}`)

  const injection = "'; drop table students; --"
  // The batch endpoint only audits rows it actually inserts, so clear the mark
  // first — otherwise this saves nothing and there is no entry to inspect.
  await api('/api/marks/remove', {
    method: 'POST',
    body: { sessionId: session.id, studentId: target.id },
    cookie: admin,
  })
  const sqlish = await api('/api/marks', {
    method: 'POST',
    body: { sessionId: session.id, studentIds: [target.id], reason: injection },
    cookie: admin,
  })
  check('a SQL-looking reason is accepted', sqlish.status === 200 && sqlish.data.saved === 1, JSON.stringify(sqlish.data))
  check('students table is intact', (await count('students')) === students.length)
  const storedReason = await one(
    'audit_log',
    `select=reason&student_id=eq.${target.id}&order=id.desc&limit=1`
  )
  check('and stored verbatim as text', storedReason.reason === injection, storedReason.reason)

  await api('/api/marks/remove', {
    method: 'POST',
    body: { sessionId: session.id, studentId: target.id },
    cookie: admin,
  })
  const longReason = await api('/api/marks', {
    method: 'POST',
    body: { sessionId: session.id, studentIds: [target.id], reason: 'x'.repeat(5000) },
    cookie: admin,
  })
  check('an oversized reason is accepted', longReason.status === 200 && longReason.data.saved === 1, JSON.stringify(longReason.data))
  const trimmed = await one(
    'audit_log',
    `select=reason&student_id=eq.${target.id}&order=id.desc&limit=1`
  )
  check('the stored reason is capped at 200 chars', trimmed.reason.length === 200, `${trimmed.reason.length}`)

  // -- deputy edges ---------------------------------------------------------
  console.log('\n- deputy edge cases -')
  // Names on the real roster contain mixed case and spacing; the label is
  // derived server-side from whichever student is chosen.
  const odd = await api('/api/grants', {
    method: 'POST',
    body: { studentId: students[7].id, hours: 2 },
    cookie: admin,
  })
  check('a grant for a roster student is accepted', odd.status === 201, JSON.stringify(odd.data))
  check(
    'the label is derived from that student, not from the client',
    odd.data.grant.label === `${students[7].name.trim()} (${students[7].roll_no})`,
    odd.data.grant.label
  )
  for (const bad of [{ label: 'Someone Made Up' }, { studentId: 'not-a-uuid' }, {}]) {
    const r = await api('/api/grants', { method: 'POST', body: { ...bad, hours: 2 }, cookie: admin })
    check(
      `a grant from ${JSON.stringify(bad)} is refused`,
      r.status >= 400 && r.status < 500,
      `${r.status}`
    )
  }
  const storedLabel = (await one('admin_grants', `select=label&id=eq.${odd.data.grant.id}`)).label
  check('the label is capped at 80 chars', storedLabel.length <= 80, `${storedLabel.length}`)

  const code = odd.data.code
  for (const variant of [code.toLowerCase(), code.replace(/-/g, ''), ` ${code} `]) {
    const r = await api('/api/admin/login', { method: 'POST', body: { password: variant } })
    check(`code accepted as ${JSON.stringify(variant.slice(0, 14))}`, r.data?.role === 'deputy', JSON.stringify(r.data))
  }

  const deputyLogin = await api('/api/admin/login', { method: 'POST', body: { password: code } })
  const deputy = cookieOf(deputyLogin.res)
  const beforeExpiry = await api(`/api/roster?s=${session.id}`, { cookie: deputy })
  check('deputy works before expiry', beforeExpiry.status === 200)
  await patch('admin_grants', `id=eq.${odd.data.grant.id}`, {
    expires_at: new Date(Date.now() - 1000).toISOString(),
  })
  const afterExpiry = await api(`/api/roster?s=${session.id}`, { cookie: deputy })
  check('the cookie stops working the moment the grant lapses', afterExpiry.status === 401, `${afterExpiry.status}`)
  const expiredExport = await api('/api/export', { cookie: deputy })
  check('and their export stops too', expiredExport.status === 401)

  const ghostGrant = await api('/api/grants', {
    method: 'POST',
    body: { studentId: students[8].id, hours: 2 },
    cookie: admin,
  })
  const ghostLogin = await api('/api/admin/login', {
    method: 'POST',
    body: { password: ghostGrant.data.code },
  })
  const ghost = cookieOf(ghostLogin.res)
  await remove('admin_grants', `id=eq.${ghostGrant.data.grant.id}`)
  const afterDelete = await api(`/api/roster?s=${session.id}`, { cookie: ghost })
  check('a deleted grant invalidates its cookie too', afterDelete.status === 401, `${afterDelete.status}`)

  // -- throttling -----------------------------------------------------------
  console.log('\n- brute force on the admin password -')
  let blockedAt = null
  for (let i = 1; i <= 14; i++) {
    const r = await api('/api/admin/login', { method: 'POST', body: { password: `wrong-${i}` } })
    if (r.status === 429 && blockedAt === null) blockedAt = i
  }
  check('repeated wrong passwords get throttled', blockedAt !== null, 'never blocked')
  check('throttling kicks in within 12 attempts', blockedAt !== null && blockedAt <= 12, `at ${blockedAt}`)
  const stillWrong = await api('/api/admin/login', { method: 'POST', body: { password: 'wrong-again' } })
  check('a further wrong password is refused with 429', stillWrong.status === 429, `${stillWrong.status}`)
  check('the response says how long to wait', typeof stillWrong.data?.retryAfterSeconds === 'number')
  // Behind campus NAT the whole class shares one address, so a student failing
  // ten sign-ins must not be able to lock the admin out mid-lesson.
  const adminGetsIn = await api('/api/admin/login', {
    method: 'POST',
    body: { password: ADMIN_PASSWORD },
  })
  check(
    'the admin still gets in while that address is throttled',
    adminGetsIn.status === 200,
    `${adminGetsIn.status}`
  )
  check(
    'and signing in clears the history',
    (await count('login_attempts')) === 0,
    `${await count('login_attempts')} left`
  )
  await remove('login_attempts', 'id=gt.0')
  const recovered = await api('/api/admin/login', {
    method: 'POST',
    body: { password: ADMIN_PASSWORD },
  })
  check('access returns once the window clears', recovered.status === 200)
  admin = cookieOf(recovered.res)

  await api('/api/admin/login', { method: 'POST', body: { password: 'wrong' } })
  await api('/api/admin/login', { method: 'POST', body: { password: ADMIN_PASSWORD } })
  check(
    'a correct password clears that address history',
    (await count('login_attempts')) === 0,
    `${await count('login_attempts')} attempts still recorded`
  )

  // -- student view edges ---------------------------------------------------
  console.log('\n- what a student sees -')
  // A student who has registered but never been marked present. Registering
  // used to be a column write; now it takes a real passkey, so this walks the
  // actual flow and then removes the attendance it necessarily created.
  const neverPresent = students.find((s) => s.roll_no === rollOf(20))
  const absentPhone = phone(BASE)
  await absentPhone.register(session.id, tok(), neverPresent.roll_no)
  await remove('attendance', `student_id=eq.${neverPresent.id}`)
  const zero = await absentPhone.record()
  check('a student with no attendance sees 0 of N', zero.data.present === 0 && zero.data.total > 0)
  check('and a real 0 percent rather than a blank', zero.data.percent === 0)
  check('every class is listed as absent', zero.data.days.every((d) => d.present === false))
  check(
    'days are most recent first',
    zero.data.days[0].classDate >= zero.data.days.at(-1).classDate
  )

  // -- export edges ---------------------------------------------------------
  console.log('\n- export edges -')
  const dates = (await select('sessions', 'select=class_date&order=class_date.asc')).map(
    (r) => r.class_date
  )
  const single = await fetch(`${BASE}/api/export?from=${dates[0]}&to=${dates[0]}`, {
    headers: { cookie: admin },
  })
  check('from equal to to exports exactly one class', single.headers.get('x-export-classes') === '1')
  const future = await fetch(`${BASE}/api/export?from=2099-01-01&to=2099-12-31`, {
    headers: { cookie: admin },
  })
  const futureBuf = Buffer.from(await future.arrayBuffer())
  check(
    'a future-only range still yields a valid workbook',
    future.status === 200 && futureBuf.subarray(0, 2).toString() === 'PK'
  )
  check('with zero class columns', future.headers.get('x-export-classes') === '0')

  // ── the origin the QR sends the class to ──────────────────────────────────
  //
  // A Vercel production deployment answers on two hosts: its immutable
  // deployment URL and the project alias. localStorage is per origin and the
  // device binding lives there, so a QR built from the admin's own host sends
  // students to whichever one the admin had open. Register on one, open the
  // other, and you are "Not registered" while the database says your roll
  // number is claimed — a device reset each time, looking like lost data.
  // -- the approval queue keeps evidence, and tidies itself ------------------
  //
  // There is no scheduler. Cleanup runs when the admin opens the panel, which
  // is the only place the queue is read — proportionate for a table that holds
  // a handful of rows a term, and one less thing that can silently stop
  // running. Rejected rows are kept for a fortnight on purpose: a refused claim
  // is the record of an attempted proxy.
  console.log('\n- the queue keeps evidence for a fortnight, then tidies -')
  {
    const DAY = 86_400_000
    const seed = (studentId, credentialId, agoMs, decision) =>
      insert('passkey_requests', {
        student_id: studentId,
        credential_id: credentialId,
        public_key: 'x',
        requested_at: new Date(Date.now() - agoMs).toISOString(),
        expires_at: new Date(Date.now() - agoMs + 3 * DAY).toISOString(),
        ...(decision ? { decision, decided_at: new Date(Date.now() - agoMs).toISOString() } : {}),
      })

    await remove('passkey_requests', 'id=not.is.null')
    await seed(students[30].id, 'age-1h', 3_600_000, null)
    await seed(students[31].id, 'age-5d', 5 * DAY, 'rejected')
    await seed(students[32].id, 'age-13d', 13 * DAY, 'rejected')
    await seed(students[33].id, 'age-20d', 20 * DAY, 'rejected')
    await seed(students[34].id, 'age-40d', 40 * DAY, 'approved')
    check('five rows seeded across a range of ages', (await count('passkey_requests')) === 5)

    const queue = await api('/api/passkey/requests', { cookie: admin })
    check('only the undecided, unexpired one is offered', queue.data.requests.length === 1)
    check('and it is the fresh one', queue.data.requests[0].rollNo === students[30].roll_no)

    const kept = (await select('passkey_requests', 'select=credential_id')).map((r) => r.credential_id)
    check('rows past a fortnight are gone', !kept.includes('age-20d') && !kept.includes('age-40d'), kept.join(','))
    check(
      'refused rows inside the fortnight are kept as evidence',
      kept.includes('age-5d') && kept.includes('age-13d'),
      kept.join(',')
    )
    await remove('passkey_requests', 'id=not.is.null')
  }

  // -- only the instructor may decide ---------------------------------------
  console.log('\n- a deputy sees the queue but cannot decide it -')
  {
    const grant = await api('/api/grants', {
      method: 'POST',
      body: { studentId: students[2].id, hours: 4 },
      cookie: admin,
    })
    const deputyLogin = await api('/api/admin/login', {
      method: 'POST',
      body: { password: grant.data.code },
    })
    const deputy = cookieOf(deputyLogin.res)

    await insert('passkey_requests', {
      student_id: students[35].id,
      credential_id: 'deputy-probe',
      public_key: 'x',
      expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    })

    const seen = await api('/api/passkey/requests', { cookie: deputy })
    check('a deputy can see the queue', seen.status === 200 && seen.data.requests.length === 1)
    check(
      'and it carries the question, never the credential',
      !JSON.stringify(seen.data).includes('public_key') &&
        !JSON.stringify(seen.data).includes('deputy-probe'),
      JSON.stringify(seen.data).slice(0, 100)
    )
    const decide = await api('/api/passkey/requests/decide', {
      method: 'POST',
      body: { requestId: seen.data.requests[0].id, approve: true },
      cookie: deputy,
    })
    check('but cannot approve one', decide.status === 403, `${decide.status}`)
    const wipe = await api('/api/passkey/remove', {
      method: 'POST',
      body: { studentId: students[35].id },
      cookie: deputy,
    })
    check('nor remove a passkey', wipe.status === 403, `${wipe.status}`)
    await remove('passkey_requests', 'id=not.is.null')
    await remove('admin_grants', 'id=not.is.null')
  }

  console.log('\n- the QR points at one fixed origin -')
  {
    // Reuse the session this suite has been driving; earlier cases may have
    // closed it, and /api/token only answers for a live one.
    await patch('sessions', `id=eq.${session.id}`, {
      is_open: true,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    })
    const tok = await api(`/api/token?s=${session.id}`, { cookie: admin })
    check('/api/token returns a scanUrl for the QR', typeof tok.data.scanUrl === 'string')

    const expected = process.env.APP_ORIGIN
    if (expected) {
      // Started with APP_ORIGIN set, as production is.
      check(
        'the scan URL uses the canonical origin, not the browsing host',
        tok.data.scanUrl.startsWith(`${expected.replace(/\/+$/, '')}/m?`),
        `got ${tok.data.scanUrl}`
      )
      check(
        'and therefore never the host this harness is talking to',
        !tok.data.scanUrl.startsWith(BASE),
        `got ${tok.data.scanUrl}`
      )
    } else {
      // No canonical origin configured, so falling back to the request origin
      // is correct — that is what keeps `next dev` and this harness working.
      // The origin the browser actually used, taken from the Host header —
      // which matters because a passkey's Relying Party ID must be a suffix of
      // the document host, and Next's own req.url normalisation does not
      // preserve that.
      const fell = new URL(tok.data.scanUrl)
      check(
        'with no APP_ORIGIN it falls back to the request origin',
        fell.protocol === 'http:' &&
          ['localhost', '127.0.0.1'].includes(fell.hostname) &&
          fell.port === String(new URL(BASE).port),
        `got ${tok.data.scanUrl}`
      )
    }
    check(
      'the scan URL carries this session and a live token',
      tok.data.scanUrl.includes(`s=${session.id}`) && tok.data.scanUrl.includes(`t=${tok.data.token}`)
    )
  }

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
