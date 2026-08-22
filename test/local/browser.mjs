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
import { one, select, remove, patch } from './db.mjs'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3100'
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
  await remove('attendance', 'session_id=not.is.null')
  await remove('sessions', 'id=not.is.null')
  await remove('audit_log', 'id=gt.0')
  await remove('login_attempts', 'id=gt.0')
  await patch('students', 'id=not.is.null', { device_id: null, enrolled_at: null })
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
    const roster = await select('students', 'select=roll_no,name&order=s_no.asc')
    const s = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage()
    await s.goto(`${BASE}/m?s=${live.id}&t=${tokenFor(live.secret, live.id, live.window_seconds)}`, {
      waitUntil: 'networkidle',
    })
    check(
      'a normal phone is still promised its roll number is remembered',
      /not need to type it again/.test(await s.locator('body').innerText())
    )
    await s.getByLabel('Roll number').fill(roster[0].roll_no)
    await s.getByRole('button', { name: /Register and mark present/ }).click()
    await s.waitForSelector('text=Present', { timeout: 30000 })
    check('a student registers and is marked on the resumed session', true)

    await s.goto(`${BASE}/m?s=${live.id}&t=badtokenxxxx`, { waitUntil: 'networkidle' })
    await s.waitForSelector('text=Code expired', { timeout: 30000 })
    const expired = await s.locator('body').innerText()
    check('the expiry notice does not hardcode a rotation', !/15 seconds/.test(expired))
  } finally {
    await browser.close()
    await cleanSlate()
  }
}

/**
 * Safari with "Block All Cookies", and some private modes, throw from
 * `setItem`. `deviceId()` then mints a fresh UUID per call, so registering here
 * binds a throwaway id and next class needs an admin reset. Registering must
 * still work — the student really is present — but the page must not promise a
 * link it cannot keep.
 */
async function storageDenied(engineName, engine, sessionInfo) {
  console.log(`\n── ${engineName}: a phone blocking site data ──`)
  const browser = await engine.launch()
  try {
    const ctx = await browser.newContext({ ...devices['iPhone 14'] })
    await ctx.addInitScript(() => {
      const boom = () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      }
      try {
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          get: () => ({
            getItem: boom,
            setItem: boom,
            removeItem: boom,
            clear: boom,
            key: boom,
            length: 0,
          }),
        })
      } catch {
        /* engine would not let us shadow it; the app is untested here, not broken */
      }
    })
    const p = await ctx.newPage()
    const errors = []
    p.on('pageerror', (e) => errors.push(e.message))
    const { id, secret, window_seconds } = sessionInfo
    await p.goto(`${BASE}/m?s=${id}&t=${tokenFor(secret, id, window_seconds)}`, {
      waitUntil: 'networkidle',
    })
    const body = (await p.locator('body').innerText()).replace(/\s+/g, ' ')

    check('the scan page still renders rather than white-screening', body.length > 10)
    check('nothing throws uncaught', errors.length === 0, errors.join(' | '))
    check('it warns that the link will not be saved', /blocking site data/.test(body))
    check('it stops promising the roll number is remembered', !/not need to type it again/.test(body))
  } finally {
    await browser.close()
  }
}

/**
 * Safari's Intelligent Tracking Prevention deletes script-writable storage —
 * localStorage included — after roughly seven days of browser use without
 * interaction on the site. A weekly class sits exactly on that boundary. When
 * it fires, the phone forgets its id while the database still holds it, so the
 * student used to be told their own roll number belonged to another phone and
 * needed an admin reset. The httpOnly cookie is the durable second copy.
 */
async function storageSurvival(engineName, engine, sessionInfo) {
  console.log(`\n── ${engineName}: surviving a storage purge between classes ──`)
  const browser = await engine.launch()
  try {
    const { id, secret, window_seconds } = sessionInfo
    const url = () => `${BASE}/m?s=${id}&t=${tokenFor(secret, id, window_seconds)}`
    const roster = await select('students', 'select=roll_no,name&order=s_no.asc')
    const ctx = await browser.newContext({ ...devices['iPhone 14'] })
    const p = await ctx.newPage()

    // Week one: an ordinary registration.
    await p.goto(url(), { waitUntil: 'networkidle' })
    await p.getByLabel('Roll number').fill(roster[0].roll_no)
    await p.getByRole('button', { name: /Register and mark present/ }).click()
    await p.waitForSelector('text=Present', { timeout: 30000 })
    check('registers normally', true)
    const cookies = await ctx.cookies()
    check(
      'the binding is also kept in an httpOnly cookie',
      cookies.some((c) => c.name === 'att_dev' && c.httpOnly)
    )

    // Week two, ITP has been through: localStorage gone, cookie intact.
    await p.evaluate(() => localStorage.clear())
    await p.goto(url(), { waitUntil: 'networkidle' })
    await p.waitForTimeout(600)
    let body = (await p.locator('body').innerText()).replace(/\s+/g, ' ')
    check(
      'localStorage purged: still recognised, no roll number retyped',
      /Present/.test(body) && !/One-time registration/.test(body),
      body.slice(0, 110)
    )

    // The other direction: cookie gone, localStorage intact.
    await ctx.clearCookies()
    await p.goto(url(), { waitUntil: 'networkidle' })
    await p.waitForTimeout(600)
    body = (await p.locator('body').innerText()).replace(/\s+/g, ' ')
    // The purge above left localStorage holding a fresh id, which the server
    // should have adopted. So dropping the cookie must not strand them.
    check(
      'the binding healed onto the id the browser now carries',
      (await one('students', `select=device_id&roll_no=eq.${roster[0].roll_no}`)).device_id ===
        (await p.evaluate(() => localStorage.getItem('att_device'))),
      'database and localStorage disagree'
    )
    await ctx.clearCookies()
    await p.goto(url(), { waitUntil: 'networkidle' })
    await p.waitForTimeout(600)
    body = (await p.locator('body').innerText()).replace(/\s+/g, ' ')
    check(
      'cookie cleared instead: localStorage alone still identifies them',
      /Present/.test(body) && !/One-time registration/.test(body),
      body.slice(0, 110)
    )

    // Both gone — a genuinely lost phone. Registration is offered, the claim is
    // refused because the database still holds the old binding, and the message
    // must say what to do rather than blame "another phone".
    await ctx.clearCookies()
    await p.evaluate(() => localStorage.clear())
    await p.goto(url(), { waitUntil: 'networkidle' })
    await p.waitForSelector('text=One-time registration', { timeout: 30000 })
    await p.getByLabel('Roll number').fill(roster[0].roll_no)
    await p.getByRole('button', { name: /Register and mark present/ }).click()
    await p.waitForTimeout(1500)
    body = (await p.locator('body').innerText()).replace(/\s+/g, ' ')
    check('both stores lost: the claim is refused', /already linked to a phone/.test(body), body.slice(0, 140))
    check(
      'and it tells them to ask for a device reset rather than blaming another phone',
      /ask the admin to reset your device/i.test(body) && !/on another phone/.test(body),
      body.slice(0, 160)
    )

    // After the admin resets, the same phone can register again.
    await patch('students', `roll_no=eq.${roster[0].roll_no}`, { device_id: null, enrolled_at: null })
    await p.goto(url(), { waitUntil: 'networkidle' })
    await p.getByLabel('Roll number').fill(roster[0].roll_no)
    await p.getByRole('button', { name: /Register and mark present/ }).click()
    await p.waitForSelector('text=Present', { timeout: 30000 })
    check('after an admin device reset it registers again', true)
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

  for (const [name, engine] of [
    ['WebKit (iOS)', webkit],
    ['Chromium (Android)', chromium],
  ]) {
    await storageDenied(name, engine, live)
  }

  for (const [name, engine] of [
    ['WebKit (iOS)', webkit],
    ['Chromium (Android)', chromium],
  ]) {
    await storageSurvival(name, engine, live)
    await patch('students', 'id=not.is.null', { device_id: null, enrolled_at: null })
  }

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
