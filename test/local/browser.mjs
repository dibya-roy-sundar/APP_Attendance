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
async function passkeyJourney(sessionInfo, adminCookie) {
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

    // First time on this phone. The failed assertion no longer drops straight
    // onto the enrolment form: cancelling a fingerprint prompt and having no
    // passkey are indistinguishable, and treating both as "here is a form"
    // is what let one phone enrol somebody else's roll number. Enrolling is
    // now a deliberate second tap.
    await page.goto(url(), { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Mark me present' }).click()
    await page.waitForSelector('text=Not confirmed', { timeout: 30000 })
    check('a failed prompt does not hand over the enrolment form', true)
    check(
      'it offers to try again',
      await page.getByRole('button', { name: 'Try again' }).isVisible()
    )
    const enrol = page.getByRole('button', { name: 'I have not set up this phone yet' })
    check('and enrolling is a separate, deliberate choice', await enrol.isVisible())
    await enrol.click()
    await page.waitForSelector('text=Set up this phone', { timeout: 30000 })
    check('a phone with no passkey can still be set up', true)
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

    // Does a real authenticator honour the widened exclusion list? Asked
    // directly rather than through the form, because reaching the form requires
    // an assertion to fail first, and an enrolled phone's assertions succeed.
    // This is the ground truth the software authenticator in the other suites
    // is only a model of.
    const exclusionProbe = await page.evaluate(async (rollNo) => {
      const b64 = (v) =>
        Uint8Array.from(atob(v.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
      const res = await fetch('/api/passkey/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          s: new URLSearchParams(location.search).get('s'),
          t: new URLSearchParams(location.search).get('t'),
          rollNo,
        }),
      })
      const { options } = await res.json()
      const excluded = (options.excludeCredentials ?? []).length
      try {
        await navigator.credentials.create({
          publicKey: {
            ...options,
            challenge: b64(options.challenge),
            user: { ...options.user, id: b64(options.user.id) },
            excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({
              ...c,
              id: b64(c.id),
            })),
          },
        })
        return { outcome: 'created', excluded }
      } catch (e) {
        return { outcome: e.name, excluded }
      }
    }, roster[1].roll_no)

    check(
      'the exclusion list carries the whole class, not just the roll number asked for',
      exclusionProbe.excluded === 1,
      `${exclusionProbe.excluded} entries with one student enrolled`
    )
    check(
      'a real authenticator refuses a second passkey on the same phone',
      exclusionProbe.outcome === 'InvalidStateError',
      exclusionProbe.outcome
    )
    check(
      'so no credential exists for that classmate',
      (await count('student_credentials', `student_id=eq.${roster[1].id}`)) === 0
    )
    check(
      'and they are not marked present',
      (await count('attendance', `session_id=eq.${id}&student_id=eq.${roster[1].id}`)) === 0
    )
    const held = await cdp.send('WebAuthn.getCredentials', { authenticatorId })
    check(
      'the keychain still holds exactly one credential',
      held.credentials.length === 1,
      `${held.credentials.length}`
    )

    // The UI half of the same rule, in a context of its own so it cannot
    // disturb the journey above: a phone this page believes is already enrolled
    // is never offered the enrolment form, even when the prompt fails.
    //
    // The flag is set directly rather than earned, because it is an affordance
    // and not a control — it is clearable, and what actually stops the attack is
    // the authenticator refusal proved just above. Its job is to stop a
    // cancelled prompt from *handing over* the form, which is how the hole was
    // found.
    {
      const other = await browser.newContext({ ...devices['Pixel 7'] })
      const p2 = await other.newPage()
      const c2 = await other.newCDPSession(p2)
      await c2.send('WebAuthn.enable')
      await c2.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      })
      await p2.goto(url(), { waitUntil: 'networkidle' })
      await p2.evaluate(() => localStorage.setItem('att_enrolled', '1'))
      await p2.reload({ waitUntil: 'networkidle' })
      await p2.getByRole('button', { name: 'Mark me present' }).click()
      await p2.waitForSelector('text=Not confirmed', { timeout: 30000 })
      check(
        'a failed prompt on a phone marked enrolled offers no way in',
        (await p2.getByRole('button', { name: 'I have not set up this phone yet' }).count()) === 0
      )
      check('only Try again', await p2.getByRole('button', { name: 'Try again' }).isVisible())
      check(
        'and no roll number field anywhere on screen',
        (await p2.getByLabel('Roll number').count()) === 0
      )
      await other.close()
    }

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
    await page.evaluate(() => localStorage.clear())
    await page.goto(url(), { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Mark me present' }).click()
    // One extra tap: a failed prompt no longer lands on the enrolment form by
    // itself, because a cancelled prompt is indistinguishable from an empty
    // keychain and that ambiguity was exploitable.
    await page.waitForSelector('text=Not confirmed', { timeout: 30000 })
    await page.getByRole('button', { name: 'I have not set up this phone yet' }).click()
    await page.waitForSelector('text=Set up this phone', { timeout: 30000 })
    check('a replacement phone is offered set-up, not an error', true)

    // A claimed roll number stays claimed, so even the real student cannot
    // re-claim it from a phone the server cannot recognise. That is the trade:
    // without it, anyone in the room could add a passkey to an absent
    // classmate's roll number and mark them present every week.
    await page.getByLabel('Roll number').fill(student.roll_no)
    await page.getByRole('button', { name: /Create passkey and mark present/ }).click()
    await page.getByText('Waiting for approval').waitFor({ timeout: 30000 })
    check('a replacement phone is queued, not silently refused', true)
    const waiting = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    check(
      'and the student is told plainly they are not marked yet',
      /not been marked present yet/.test(waiting),
      waiting.slice(0, 120)
    )
    check(
      'nothing was recorded for them by that phone',
      (await count('attendance', `session_id=eq.${id}&student_id=eq.${student.id}`)) === 1
    )

    // The admin approves it, which replaces the lost passkey rather than
    // adding to it.
    const queued = await (
      await fetch(`${BASE}/api/passkey/requests`, { headers: { cookie: adminCookie } })
    ).json()
    const mine = queued.requests.find((r) => r.rollNo === student.roll_no)
    check('the claim appears in the admin queue', Boolean(mine), JSON.stringify(queued).slice(0, 120))
    const decided = await fetch(`${BASE}/api/passkey/requests/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ requestId: mine.id, approve: true, reason: 'lost phone' }),
    })
    check('the admin approves it', decided.status === 200, `${decided.status}`)

    await page.goto(url(), { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Mark me present' }).click()
    await page.getByText('Present', { exact: true }).waitFor({ timeout: 30000 })
    check('then the replacement phone marks present with one tap', true)
    check(
      'approval replaced rather than added — still one passkey',
      (await count('student_credentials', `student_id=eq.${student.id}`)) === 1
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

    // The count is what tells a phone change apart from a problem.
    check(
      'the roster reports the passkey count',
      (await select('student_credentials', `select=id&student_id=eq.${student.id}`)).length === 1
    )
  } finally {
    await browser.close()
  }
}


/**
 * What can be checked on WebKit, and what cannot.
 *
 * Playwright's virtual authenticator is a Chrome DevTools Protocol feature, so
 * WebKit has no way to hold a credential — the whole registration ceremony is
 * unreachable there. For a long time that meant the scan screen was never
 * rendered in WebKit at all, and every claim about iPhone behaviour was an
 * inference from Chromium.
 *
 * The layer that does *not* need an authenticator is testable, and it is the one
 * the reported bug lived in: what the screen does when the ceremony fails. So
 * that is checked on both engines here.
 *
 * Measured difference worth knowing: with no authenticator attached,
 * `navigator.credentials.get()` rejects with NotAllowedError on WebKit and
 * NotSupportedError on Chromium. The client catches any exception rather than
 * matching on names, which is why both engines behave the same — and is the
 * reason not to start matching on them.
 *
 * Still unverified anywhere but Chromium, and unverifiable in CI: the
 * excludeCredentials refusal. That needs a real iPhone.
 */
async function scanScreenJourney(engineName, engine, phoneName, session) {
  console.log(`\n── ${engineName}: what the scan screen does when the prompt fails ──`)
  const browser = await engine.launch()
  const context = await browser.newContext({ ...devices[phoneName] })
  const page = await context.newPage()
  const scanUrl = () =>
    `${BASE}/m?s=${session.id}&t=${tokenFor(session.secret, session.id, session.window_seconds)}`

  await page.goto(scanUrl(), { waitUntil: 'networkidle' })
  check(
    `${engineName}: passkeys are offered, not refused as unsupported`,
    (await page.getByRole('button', { name: 'Mark me present' }).count()) === 1,
    (await page.locator('h1').first().innerText()).trim()
  )
  check(
    `${engineName}: PublicKeyCredential is present`,
    await page.evaluate(() => typeof window.PublicKeyCredential === 'function')
  )

  // No authenticator on this engine, so the assertion fails — the same event as
  // a cancelled prompt, which is the ambiguity the bug exploited.
  await page.getByRole('button', { name: 'Mark me present' }).click()
  await page.waitForSelector('text=Not confirmed', { timeout: 30000 })
  check(`${engineName}: a failed prompt lands on Not confirmed, not the form`, true)
  check(
    `${engineName}: no roll number field is shown`,
    (await page.getByLabel('Roll number').count()) === 0
  )
  check(
    `${engineName}: Try again is the primary action`,
    await page.getByRole('button', { name: 'Try again' }).isVisible()
  )
  check(
    `${engineName}: enrolling is offered, since nothing says this phone is set up`,
    (await page.getByRole('button', { name: 'I have not set up this phone yet' }).count()) === 1
  )

  // And with the phone marked as enrolled, the way in disappears.
  await page.evaluate(() => localStorage.setItem('att_enrolled', '1'))
  await page.goto(scanUrl(), { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Mark me present' }).click()
  await page.waitForSelector('text=Not confirmed', { timeout: 30000 })
  check(
    `${engineName}: an enrolled phone is offered no way to enrol again`,
    (await page.getByRole('button', { name: 'I have not set up this phone yet' }).count()) === 0
  )
  check(
    `${engineName}: still no roll number field`,
    (await page.getByLabel('Roll number').count()) === 0
  )

  await browser.close()
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

  // Both engines for the part that does not need an authenticator, then
  // Chromium alone for the part that does.
  for (const [name, engine, phone] of [
    ['WebKit (iOS)', webkit, 'iPhone 14'],
    ['Chromium (Android)', chromium, 'Pixel 7'],
  ]) {
    await scanScreenJourney(name, engine, phone, live)
  }

  await passkeyJourney(live, jar)

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
