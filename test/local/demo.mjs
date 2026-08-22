/**
 * Watchable end-to-end walkthrough in a real phone-sized browser window.
 *
 *   set -a; . ./.env.local; set +a
 *   node test/local/demo.mjs            # visible window, paced to follow
 *   node test/local/demo.mjs --fast     # same journey, no pauses
 *   node test/local/demo.mjs --headless # no window, screenshots only
 *
 * Two windows open: the instructor's and a student's phone. Every step is
 * narrated in the terminal and captured to test/local/demo-shots/.
 */
import { chromium, devices } from 'playwright'
import { mkdir, rm } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
import { one, patch, remove, select } from './db.mjs'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3100'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
const FAST = process.argv.includes('--fast')
const HEADLESS = process.argv.includes('--headless')
const SHOTS = 'test/local/demo-shots'

const PHONE = devices['Pixel 7']
let step = 0

const beat = (ms) => new Promise((r) => setTimeout(r, FAST ? 60 : ms))

async function shot(page, name) {
  step++
  const file = `${SHOTS}/${String(step).padStart(2, '0')}-${name}.png`
  await page.screenshot({ path: file })
  return file
}

async function say(page, text, name) {
  const file = await shot(page, name)
  console.log(`  ${String(step).padStart(2, '0')}. ${text}`)
  console.log(`      ${file}`)
  await beat(1400)
}

const tokenFor = (secret, sid, period = 15) =>
  createHmac('sha256', secret)
    .update(`${sid}:${Math.floor(Date.now() / 1000 / period)}`)
    .digest('base64url')
    .slice(0, 12)

async function main() {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD not set')
  await rm(SHOTS, { recursive: true, force: true })
  await mkdir(SHOTS, { recursive: true })

  console.log('\nresetting to a clean term before the walkthrough')
  await remove('admin_grants', 'id=not.is.null')
  await remove('attendance', 'session_id=not.is.null')
  await remove('audit_log', 'id=gt.0')
  await remove('sessions', 'id=not.is.null')
  await patch('students', 'id=not.is.null', {
    device_id: null,
    enrolled_at: null,
  })

  const students = await select('students', 'select=id,roll_no,name&order=s_no.asc')
  console.log(`roster: ${students.length} students\n`)

  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: FAST || HEADLESS ? 0 : 220,
    args: ['--window-position=40,40'],
  })

  // ── the instructor's phone ────────────────────────────────────────────────
  const teacher = await browser.newContext({ ...PHONE })
  const t = await teacher.newPage()

  console.log('ADMIN')
  await t.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await say(t, 'Landing page, dark by default, with the theme switch', 'home-dark')

  // Show the toggle working before going further.
  await t.getByRole('button', { name: 'Light', exact: true }).click()
  await beat(900)
  await say(t, 'Switched to the light theme', 'home-light')
  await t.getByRole('button', { name: 'Dark', exact: true }).click()
  await beat(600)

  await t.getByRole('link', { name: 'Admin' }).click()
  await t.waitForLoadState('networkidle')
  await say(t, 'Admin sign-in — password or a temporary access code', 'admin-login')

  await t.getByLabel('Password or access code').fill(ADMIN_PASSWORD)
  await t.getByRole('button', { name: 'Sign in' }).click()
  await t.waitForSelector('text=marked', { timeout: 15000 })
  await beat(800)
  await say(t, 'The roster grid: all 47, read-only until a session starts', 'admin-empty')

  // No registration window any more: a phone registers itself the first time it
  // scans, and a student who loses that binding asks for a device reset.
  await t.getByRole('button', { name: 'More', exact: true }).click()
  await beat(500)
  await say(t, 'More: device resets, temporary access, past dates', 'admin-more')
  await t.getByRole('button', { name: 'More', exact: true }).click()
  await beat(400)

  // Start the session, choosing duration and rotation.
  await t.getByRole('button', { name: 'Start session' }).click()
  await beat(600)
  await say(t, 'Choosing how long attendance stays open and how fast the QR turns', 'admin-setup')
  await t.getByRole('button', { name: '45 min' }).click()
  await t.getByRole('button', { name: '30 s', exact: true }).click()
  await beat(400)
  await say(t, 'Picked 45 minutes, QR rotating every 30 seconds', 'admin-setup-chosen')
  await t.getByRole('button', { name: /Start for 45 min/ }).click()
  await t.waitForSelector('text=Session live', { timeout: 15000 })
  await beat(900)
  await say(t, 'Session live, counting down, rotation shown in the header', 'admin-live')

  const session = await one('sessions', 'select=id,secret,window_seconds&order=opened_at.desc&limit=1')

  await t.getByRole('button', { name: 'Show QR' }).click()
  await t.waitForSelector('img[alt="Attendance QR code"]', { timeout: 15000 })
  await beat(1500)
  await say(t, 'Fullscreen QR for projecting — this is what students scan', 'admin-qr')
  await t.getByRole('button', { name: 'Close' }).click()
  await beat(500)

  // ── a student's phone ─────────────────────────────────────────────────────
  console.log('\nSTUDENT (a second phone)')
  const phone = await browser.newContext({ ...PHONE })
  const s = await phone.newPage()
  const target = students[35] // MT2026520, Rishank Jain

  const scanUrl = () =>
    `${BASE}/m?s=${session.id}&t=${tokenFor(session.secret, session.id, session.window_seconds)}`

  await s.goto(scanUrl(), { waitUntil: 'networkidle' })
  await s.waitForSelector('text=registration', { timeout: 15000 })
  await beat(900)
  await say(s, 'Scanned the QR. First time, so it asks for a roll number once', 'student-enrol')

  await s.getByLabel('Roll number').fill(target.roll_no)
  await beat(500)
  await s.getByRole('button', { name: /Register and mark present/ }).click()
  await s.waitForSelector('text=Present', { timeout: 15000 })
  await beat(1000)
  await say(s, `Present — ${target.name}. Phone now bound to this student`, 'student-present')

  // Scanning again is a no-op, not an error.
  await s.goto(scanUrl(), { waitUntil: 'networkidle' })
  await s.waitForSelector('text=Present', { timeout: 15000 })
  await beat(700)
  await say(s, 'Scanning a second time: still one row, no scary error', 'student-again')

  // ── back to the grid, live ────────────────────────────────────────────────
  console.log('\nADMIN — the mark appears')
  await t.waitForTimeout(5200) // the grid polls every 5s
  await say(t, 'The scan has appeared on the grid with its time', 'admin-one-marked')

  // Mark someone by hand, and annotate it.
  const byHand = students[2]
  await t.getByRole('button', { name: new RegExp(byHand.roll_no) }).click()
  await beat(900)
  await say(t, `Tapped ${byHand.name} — marked by hand, reason chips offered`, 'admin-manual')
  await t.getByRole('button', { name: 'phone dead' }).click()
  await beat(900)
  await say(t, 'Reason recorded against the audit entry, row unchanged', 'admin-reason')

  // Export with a date range, and the local history.
  await t.getByRole('button', { name: 'Download .xlsx' }).click()
  await beat(600)
  await say(t, 'Export: presets, a custom range, and a local download history', 'admin-export')
  const download = t.waitForEvent('download', { timeout: 20000 })
  await t.getByRole('button', { name: 'Whole term' }).click()
  const file = await download
  console.log(`      downloaded: ${file.suggestedFilename()}`)
  await beat(1200)
  await say(t, 'Downloaded, and the history now lists it', 'admin-export-history')
  await t.getByRole('button', { name: 'Download .xlsx' }).click()
  await beat(400)

  // Temporary access for a stand-in.
  await t.getByRole('button', { name: 'More', exact: true }).click()
  await beat(400)
  await t.getByRole('button', { name: 'Manage' }).click()
  await beat(700)
  await say(t, 'Temporary access, for a day someone else covers the class', 'admin-access')
  await t.getByPlaceholder(/Search the roster/).fill('Rishank')
  await t.waitForTimeout(400)
  await t.getByRole('button', { name: /MT2026520/ }).first().click()
  await t.getByRole('button', { name: '4h', exact: true }).click()
  await t.getByRole('button', { name: 'Issue code' }).click()
  await t.waitForSelector('text=Give this to', { timeout: 15000 })
  await beat(1200)
  await say(t, 'A one-time code, shown once and stored only as a hash', 'admin-code')

  const code = (await t.locator('code').first().textContent()).trim()
  console.log(`      code issued: ${code}`)

  // ── the deputy's phone ────────────────────────────────────────────────────
  console.log('\nDEPUTY (signing in with the code)')
  const sub = await browser.newContext({ ...PHONE })
  const d = await sub.newPage()
  await d.goto(`${BASE}/admin`, { waitUntil: 'networkidle' })
  await d.getByLabel('Password or access code').fill(code)
  await d.getByRole('button', { name: 'Sign in' }).click()
  await d.waitForSelector('text=Temporary access as', { timeout: 15000 })
  await beat(1100)
  await say(d, 'Signed in as a deputy: banner, and the class is theirs to run', 'deputy-banner')

  await d.getByRole('button', { name: 'Download .xlsx' }).click()
  await beat(700)
  await say(d, 'Their copies come out view-only and stamped with their name', 'deputy-export')
  await d.getByRole('button', { name: 'More', exact: true }).click()
  await beat(700)
  await say(d, 'No device resets and no temporary access for a deputy', 'deputy-more-limited')

  // ── the student's own record ───────────────────────────────────────────────
  console.log('\nSTUDENT — their own record')
  await s.goto(`${BASE}/me`, { waitUntil: 'networkidle' })
  await s.waitForSelector('text=Classes attended', { timeout: 15000 })
  await beat(1000)
  await say(s, 'Their calendar: present, absent, and days with no class', 'student-calendar')
  await s.getByRole('button', { name: 'Light', exact: true }).click()
  await beat(900)
  await say(s, 'The same page in the light theme', 'student-calendar-light')

  console.log('\nwalkthrough complete\n')
  if (!HEADLESS && !FAST) {
    console.log('windows stay open for 20 seconds so you can look around')
    await beat(20000)
  }

  await browser.close()
}

main().catch((e) => {
  console.error('\ndemo failed:', e.message)
  process.exit(1)
})
