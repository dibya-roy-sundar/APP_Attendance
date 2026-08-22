/**
 * Real-world edge cases: hostile input, races, boundaries, and the failure modes
 * a classroom actually produces. Includes regressions for bugs found by probing.
 *
 *   set -a; . ./.env.local; set +a
 *   node test/local/edge.mjs
 */
import { createHmac } from 'node:crypto'
import { count, one, patch, remove, select } from './db.mjs'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3100'
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

  await remove('admin_grants', 'id=not.is.null')
  await remove('attendance', 'session_id=not.is.null')
  await remove('audit_log', 'id=gt.0')
  await remove('sessions', 'id=not.is.null')
  await patch('students', 'id=not.is.null', {
    device_id: null,
    reset_allowed: false,
    enrolled_at: null,
  })
  await patch('settings', 'key=eq.enrollment_open', { value: 'true' })

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
    const r = await api('/api/enroll', {
      method: 'POST',
      body: { s: session.id, t: tok(), rollNo: probe, deviceId: uuid() },
    })
    check(
      `"${probe}" cannot claim anyone`,
      r.status === 404 && r.data.error === 'UNKNOWN_ROLL',
      `${r.status} ${JSON.stringify(r.data)}`
    )
  }
  check('nobody got claimed by a wildcard', (await count('students', 'device_id=not.is.null')) === 0)

  console.log('\n- roll number tolerance for honest typing -')
  const devLower = uuid()
  const lower = await api('/api/enroll', {
    method: 'POST',
    body: { s: session.id, t: tok(), rollNo: rollOf(0).toLowerCase(), deviceId: devLower },
  })
  check('lowercase roll number is accepted', lower.data?.status === 'ENROLLED', JSON.stringify(lower.data))

  const spaced = await api('/api/enroll', {
    method: 'POST',
    body: { s: session.id, t: tok(), rollNo: `  ${rollOf(1)}  `, deviceId: uuid() },
  })
  check('surrounding whitespace is trimmed', spaced.data?.status === 'ENROLLED')

  for (const [label, rollNo] of [
    ['an empty roll number', ''],
    ['whitespace only', '   '],
    ['a 500-character roll number', 'M'.repeat(500)],
    ['an unrelated roll number', 'XX9999999'],
  ]) {
    const r = await api('/api/enroll', {
      method: 'POST',
      body: { s: session.id, t: tok(), rollNo, deviceId: uuid() },
    })
    check(`${label} is refused cleanly`, r.status < 500 && Boolean(r.data?.error), `${r.status}`)
  }
  for (const bad of [42, null, {}, [], true]) {
    const r = await api('/api/enroll', {
      method: 'POST',
      body: { s: session.id, t: tok(), rollNo: bad, deviceId: uuid() },
    })
    check(`a ${typeof bad} roll number does not crash`, r.status < 500, `${r.status}`)
  }

  // -- device identity -------------------------------------------------------
  console.log('\n- device identity -')
  const second = await api('/api/enroll', {
    method: 'POST',
    body: { s: session.id, t: tok(), rollNo: rollOf(2), deviceId: devLower },
  })
  check('one phone cannot claim a second student', second.data?.error === 'DEVICE_ALREADY_BOUND')

  const upper = await api('/api/mark', {
    method: 'POST',
    body: { s: session.id, t: tok(), deviceId: devLower.toUpperCase() },
  })
  check('an uppercased device UUID still resolves', upper.data?.status === 'MARKED', JSON.stringify(upper.data))

  for (const bad of ['', 'not-a-uuid', '12345', uuid().slice(0, -1), null, 7]) {
    const r = await api('/api/mark', {
      method: 'POST',
      body: { s: session.id, t: tok(), deviceId: bad },
    })
    check(`device id ${JSON.stringify(bad)} is refused`, r.data?.error === 'BAD_DEVICE', `${r.status}`)
  }

  console.log('\n- two phones race for the same roll number -')
  const raceRoll = rollOf(5)
  const raced = await Promise.all(
    [uuid(), uuid(), uuid()].map((d) =>
      api('/api/enroll', {
        method: 'POST',
        body: { s: session.id, t: tok(), rollNo: raceRoll, deviceId: d },
      })
    )
  )
  const won = raced.filter((r) => r.data?.status === 'ENROLLED').length
  check('exactly one phone wins the claim', won === 1, `${won} won`)
  check(
    'the losers are told it is claimed',
    raced.filter((r) => r.data?.error === 'ALREADY_CLAIMED').length === 2
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
    const r = await api('/api/mark', {
      method: 'POST',
      body: { s: session.id, t, deviceId: devLower },
    })
    check(`${label} is rejected`, r.data?.error === 'BAD_TOKEN', JSON.stringify(r.data))
  }

  // -- session boundaries ---------------------------------------------------
  console.log('\n- session boundaries -')
  await patch('sessions', `id=eq.${session.id}`, {
    expires_at: new Date(Date.now() - 1).toISOString(),
  })
  const atBoundary = await api('/api/mark', {
    method: 'POST',
    body: { s: session.id, t: tok(), deviceId: devLower },
  })
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
  const midnightScan = await api('/api/mark', {
    method: 'POST',
    body: { s: session.id, t: tok(), deviceId: devLower },
  })
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
    api('/api/mark', { method: 'POST', body: { s: session.id, t: tok(), deviceId: devLower } }),
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
  const brokenJson = await api('/api/mark', { method: 'POST', raw: '{"s": "abc",' })
  check('truncated JSON gives 4xx, not 500', brokenJson.status >= 400 && brokenJson.status < 500, `${brokenJson.status}`)
  const emptyBody = await api('/api/mark', { method: 'POST', raw: '' })
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
  await patch('settings', 'key=eq.login_throttle', { value: '{}' })
  let blockedAt = null
  for (let i = 1; i <= 14; i++) {
    const r = await api('/api/admin/login', { method: 'POST', body: { password: `wrong-${i}` } })
    if (r.status === 429 && blockedAt === null) blockedAt = i
  }
  check('repeated wrong passwords get throttled', blockedAt !== null, 'never blocked')
  check('throttling kicks in within 12 attempts', blockedAt !== null && blockedAt <= 12, `at ${blockedAt}`)
  const held = await api('/api/admin/login', { method: 'POST', body: { password: ADMIN_PASSWORD } })
  check('even the right password is held off while throttled', held.status === 429, `${held.status}`)
  check('the response says how long to wait', typeof held.data?.retryAfterSeconds === 'number')

  await patch('settings', 'key=eq.login_throttle', { value: '{}' })
  const recovered = await api('/api/admin/login', {
    method: 'POST',
    body: { password: ADMIN_PASSWORD },
  })
  check('access returns once the window clears', recovered.status === 200)
  admin = cookieOf(recovered.res)

  await api('/api/admin/login', { method: 'POST', body: { password: 'wrong' } })
  await api('/api/admin/login', { method: 'POST', body: { password: ADMIN_PASSWORD } })
  const cleared = JSON.parse((await one('settings', 'select=value&key=eq.login_throttle')).value)
  check('a correct password clears that address history', Object.keys(cleared).length === 0, JSON.stringify(cleared))

  // -- student view edges ---------------------------------------------------
  console.log('\n- what a student sees -')
  const ghostDevice = '11111111-2222-3333-4444-555555555555'
  const neverPresent = students.find((s) => s.roll_no === rollOf(20))
  await patch('students', `id=eq.${neverPresent.id}`, { device_id: ghostDevice })
  const zero = await api('/api/me', { method: 'POST', body: { deviceId: ghostDevice } })
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
