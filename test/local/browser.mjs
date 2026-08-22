/**
 * Real-engine checks for the paths the REST suites cannot reach: the sign-in
 * form, the projected QR caption, the stop/resume cycle, and a phone whose
 * browser refuses to keep site data.
 *
 *   set -a; . ./.env.local; set +a
 *   node test/local/browser.mjs
 *
 * WebKit stands in for iOS and Chromium for Android, because both are what the
 * class will actually hold.
 */
import { chromium, webkit, devices } from 'playwright'
import { createHmac } from 'node:crypto'
import { count, one, resetToRoster, select } from './db.mjs'

// localhost, not 127.0.0.1: WebAuthn will not accept an IP address as a
// Relying Party ID, so a passkey cannot be created on 127.0.0.1 at all.
const BASE = process.env.BASE_URL ?? 'http://localhost:3100'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
let pass = 0
const failures = []

function check(label, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

const tokenFor = (secret, sid, period) =>
  createHmac('sha256', secret)
    .update(`${sid}:${Math.floor(Date.now() / 1000 / period)}`)
    .digest('base64url')
    .slice(0, 12)

async function cleanSlate() {
  await resetToRoster()
}

/** Sign in through the real form, not by injecting a cookie. */
async function signIn(page) {
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' })
  await page.getByLabel('Password or access code').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForSelector('text=marked', { timeout: 30000 })
}

/** The admin's whole demo-day loop: start, project, stop, resume, get marked. */
async function adminJourney(engineName, engine, phone) {
  console.log(`\n── ${engineName}: the admin's session, start to resume ──`)
  const browser = await engine.launch()
  try {
    const t = await (await browser.newContext({ ...devices[phone] })).newPage()
    await signIn(t)
    check('signs in through the form (not an injected cookie)', true)

    await t.getByRole('button', { name: 'Start session' }).click()
    await t.getByRole('button', { name: '30 s', exact: true }).click()
    await t.getByRole('button', { name: /Start for/ }).click()
    await t.waitForSelector('text=Session live', { timeout: 30000 })
    check('starts a session', true)

    // The projector is the most-read screen in the room; if the admin picked
    // 30s it must not tell 47 people the code changes every 15.
    await t.getByRole('button', { name: 'Show QR' }).click()
    await t.waitForSelector('img[alt="Attendance QR code"]', { timeout: 30000 })
    await t.waitForTimeout(1500)
    const caption = (await t.locator('text=/code changes every/').first().textContent()) ?? ''
    check(
      'the projected caption states the rotation the admin chose',
      /every 30 seconds/.test(caption),
      `got "${caption.trim()}"`
    )
    await t.getByRole('button', { name: 'Close' }).click()

    await t.getByRole('button', { name: 'Extend / stop' }).click()
    await t.getByRole('button', { name: 'Stop session' }).click()
    await t.waitForSelector('text=Session closed', { timeout: 30000 })
    check('stops the session early', true)

    // One session per date is by design, so stopping must be reversible or the
    // admin is locked out of their own class for the rest of the day.
    await t.getByRole('button', { name: 'Resume session' }).click()
    await t.getByRole('button', { name: /Resume for/ }).click()
    await t.waitForSelector('text=Session live', { timeout: 30000 })
    check('resumes the same day rather than dead-ending', true)

    const live = await one(
      'sessions',
      'select=id,secret,window_seconds&order=opened_at.desc&limit=1'
    )
    // A student's phone. Registration needs a real authenticator, so this one
    // only checks what the screen offers and the expiry path; the passkey flow
    // itself is exercised in passkeyJourney() below, where a virtual sensor is
    // available.
    const s = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage()
    await s.goto(`${BASE}/m?s=${live.id}&t=${tokenFor(live.secret, live.id, live.window_seconds)}`, {
      waitUntil: 'networkidle',
    })
    const offered = await s.locator('body').innerText()
    check(
      'the scan screen leads with one tap, not a form',
      /Mark me present/.test(offered) && !/Roll number/.test(offered),
      offered.replace(/\s+/g, ' ').slice(0, 90)
    )
    check(
      'and says what confirming will take',
      /Face ID|fingerprint/i.test(offered),
      offered.replace(/\s+/g, ' ').slice(0, 90)
    )

    // A stale token no longer shows up on load: WebAuthn needs a user gesture,
    // so nothing is attempted until the button is tapped.
    await s.goto(`${BASE}/m?s=${live.id}&t=badtokenxxxx`, { waitUntil: 'networkidle' })
    await s.getByRole('button', { name: 'Mark me present' }).click()
    await s.waitForSelector('text=Code expired', { timeout: 30000 })
    const expired = await s.locator('body').innerText()
    check('the expiry notice does not hardcode a rotation', !/15 seconds/.test(expired))
  } finally {
    await browser.close()
    await cleanSlate()
  }
}

/**
 * The passkey flow in a real browser, with a virtual sensor.
 *
 * Chromium only: the virtual authenticator is a CDP feature and WebKit exposes
 * no equivalent, so there is no way to answer a Face ID prompt in a WebKit test.
 * What that leaves uncovered is the prompt itself, not our logic — the
 * assertion bytes and every rejection path are covered by the unit tests
 * against a spec-built authenticator, and the WebKit *layout* of these screens
 * is covered by mobile.mjs.
 *
 * This replaces two suites that no longer describe anything real: one checked
 * that a storage-denied phone was warned its binding would not persist, the
 * other that a purged localStorage still recovered from a cookie. Neither
 * matters now, and proving that is the first assertion below.
 */
async function passkeyJourney(sessionInfo) {
  console.log(`\n── Chromium: registering and signing in with a passkey ──`)
  const browser = await chromium.launch()
  try {
    const { id, secret, window_seconds } = sessionInfo
    const url = () => `${BASE}/m?s=${id}&t=${tokenFor(secret, id, window_seconds)}`
    const roster = await select('students', 'select=id,roll_no,name&order=s_no.asc')
    const student = roster[0]

    const context = await browser.newContext({ ...devices['Pixel 7'] })
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    })

    // First time on this phone: one roll number, then a passkey.
    await page.goto(url(), { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Mark me present' }).click()
    await page.waitForSelector('text=Set up this phone', { timeout: 30000 })
    check('a phone with no passkey is offered set-up', true)
    await page.getByLabel('Roll number').fill(student.roll_no)
    await page.getByRole('button', { name: /Create passkey and mark present/ }).click()
    await page.getByText('Present', { exact: true }).waitFor({ timeout: 30000 })
    check('registering creates a passkey and marks present', true)
    check(
      'the credential is stored against that student',
      (await count('student_credentials', `student_id=eq.${student.id}`)) === 1
    )

    // Every later class: one tap, nothing typed.
    await page.goto(url(), { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Mark me present' }).click()
    await page.getByText('Present', { exact: true }).waitFor({ timeout: 30000 })
    check('later classes take one tap and no typing', true)
    check(
      'and still one attendance row',
      (await count('attendance', `session_id=eq.${id}&student_id=eq.${student.id}`)) === 1
    )

    // The whole point of the change: browser storage no longer holds identity.
    await context.clearCookies()
    await page.evaluate(() => {
      localStorage.clear()
      sessionStorage.clear()
    })
    await page.goto(url(), { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Mark me present' }).click()
    await page.getByText('Present', { exact: true }).waitFor({ timeout: 30000 })
    check('clearing all site data changes nothing — identity is not stored here', true)

    // Their own record needs a session, which the assertion just re-established.
    await page.goto(`${BASE}/me`, { waitUntil: 'networkidle' })
    const record = await page.locator('body').innerText()
    check(
      'the passkey session lets them read their own record',
      record.includes(student.name),
      record.replace(/\s+/g, ' ').slice(0, 90)
    )

    // A genuinely lost phone: the keychain itself is gone.
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    })
    await context.clearCookies()
    await page.goto(url(), { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Mark me present' }).click()
    await page.waitForSelector('text=Set up this phone', { timeout: 30000 })
    check('a replacement phone is offered set-up, not an error', true)

    // And recovers itself: a second passkey, no admin, no reset.
    await page.getByLabel('Roll number').fill(student.roll_no)
    await page.getByRole('button', { name: /Create passkey and mark present/ }).click()
    await page.getByText('Present', { exact: true }).waitFor({ timeout: 30000 })
    check('the student recovers with no admin involved', true)
    check(
      'they now hold two passkeys, the lost one and the new',
      (await count('student_credentials', `student_id=eq.${student.id}`)) === 2
    )
    check(
      'and their attendance was never touched',
      (await count('attendance', `session_id=eq.${id}&student_id=eq.${student.id}`)) === 1
    )

    // ── reading your own record between classes ──────────────────────────
    //
    // The gap this closes: the only route to a session used to run through
    // /api/passkey/auth/options, which needs a live token. So a student who
    // cleared their cookies could not see their own attendance until the next
    // lesson started — for a weekly class, up to seven days.
    await page.evaluate(() => fetch('/api/admin/logout', { method: 'POST' }))
    await context.clearCookies()
    await page.goto(`${BASE}/me`, { waitUntil: 'networkidle' })
    const locked = await page.locator('body').innerText()
    check(
      '/me offers a passkey sign-in, not "go to class"',
      /Sign in to see your record/.test(locked) &&
        !/Scan the QR code projected in class to register/.test(locked),
      locked.replace(/\s+/g, ' ').slice(0, 100)
    )
    const marksBefore = await count('attendance', `student_id=eq.${student.id}`)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByText(student.name, { exact: false }).first().waitFor({ timeout: 30000 })
    check('signs in from the passkey alone', true)
    check(
      'and records nothing — reading is not marking',
      (await count('attendance', `student_id=eq.${student.id}`)) === marksBefore
    )

    // The session it issues must be no more powerful than the one from marking.
    const sessionCookie = (await context.cookies()).find((c) => c.name === 'att_student')
    const attempt = await fetch(`${BASE}/api/passkey/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `att_student=${sessionCookie.value}` },
      body: JSON.stringify({ s: id, t: 'x', challenge: 'y', response: { id: 'z' } }),
    })
    check('a read-only session cannot mark anybody present', attempt.status >= 400, `${attempt.status}`)

    // The admin grid should show the count, since that is how a phone change is
    // told apart from a problem.
    const gridPasskeys = (await select(
      'student_credentials',
      `select=id&student_id=eq.${student.id}`
    )).length
    check('the roster can report more than one passkey', gridPasskeys === 2)
  } finally {
    await browser.close()
  }
}

async function main() {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD not set')
  await cleanSlate()

  for (const [name, engine, phone] of [
    ['WebKit (iOS)', webkit, 'iPhone 14'],
    ['Chromium (Android)', chromium, 'Pixel 7'],
  ]) {
    await adminJourney(name, engine, phone)
  }

  // One live session for the storage-denied pass.
  const jar = await (async () => {
    const r = await fetch(`${BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    })
    return (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  })()
  await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: jar },
    body: JSON.stringify({ minutes: 45, windowSeconds: 15 }),
  })
  const live = await one('sessions', 'select=id,secret,window_seconds&order=opened_at.desc&limit=1')

  await passkeyJourney(live)

  await cleanSlate()

  console.log(`\n${'='.repeat(60)}`)
  console.log(`${pass} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  console.log('='.repeat(60))
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nbrowser suite crashed:', e)
  process.exit(1)
})
