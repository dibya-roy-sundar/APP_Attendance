/**
 * Mobile audit against real engines: WebKit for iOS Safari, Chromium for Android.
 *
 * Measures rather than asserts — horizontal overflow, tap-target sizes, input
 * font sizes (iOS zooms below 16px), safe-area handling, and PWA installability.
 *
 *   set -a; . ./.env.local; set +a
 *   node test/local/mobile.mjs [--shots]
 */
import { chromium, devices, webkit } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
import { one, resetToRoster, select } from './db.mjs'
import { phone } from './student.mjs'

// localhost, not 127.0.0.1: WebAuthn will not accept an IP address as a
// Relying Party ID, so a passkey cannot be created on 127.0.0.1 at all.
const BASE = process.env.BASE_URL ?? 'http://localhost:3100'
// Cookies must be set for the host actually under test. This was hardcoded to
// 'localhost', so a run against production set both cookies on a domain the
// browser never sent them to: /admin rendered the login screen, every admin
// control was missing, and the guards below skipped all seven admin screens
// without a word. 227 checks passed against the wrong pages, and only the
// check-count floor at the end caught it.
const COOKIE_DOMAIN = new URL(BASE).hostname
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
const SHOTS = process.argv.includes('--shots')
/** Which theme to audit: `--theme light` or `--theme dark` (default). */
const THEME = process.argv.includes('--theme')
  ? process.argv[process.argv.indexOf('--theme') + 1]
  : 'dark'
const SHOT_DIR = 'test/local/screens'

/** Apple HIG says 44pt; Android Material says 48dp. Hold to the stricter one. */
const MIN_TAP = 44
/** iOS Safari zooms the page when a focused input's text is below this. */
const MIN_INPUT_FONT = 16

let pass = 0
let fail = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`    ok   ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ` - ${detail}` : ''}`)
    console.log(`    FAIL ${name}${detail ? ` - ${detail}` : ''}`)
  }
}

/**
 * The real spread of phones in a lecture hall: an old small Android, the
 * commonest iPhone sizes, a big Android, and a foldable-narrow worst case.
 */
const PHONES = [
  { name: 'iPhone SE (375x667)', engine: 'webkit', preset: devices['iPhone SE'] },
  { name: 'iPhone 14 (390x664)', engine: 'webkit', preset: devices['iPhone 14'] },
  { name: 'iPhone 14 Pro Max (430x739)', engine: 'webkit', preset: devices['iPhone 14 Pro Max'] },
  { name: 'Pixel 7 (412x839)', engine: 'chromium', preset: devices['Pixel 7'] },
  { name: 'Galaxy S9+ (320x658)', engine: 'chromium', preset: devices['Galaxy S9+'] },
  {
    name: 'Narrow 280px (fold closed)',
    engine: 'chromium',
    preset: {
      viewport: { width: 280, height: 653 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: devices['Pixel 7'].userAgent,
    },
  },
]

async function measure(page) {
  return page.evaluate(
    ({ MIN_TAP, MIN_INPUT_FONT }) => {
      const doc = document.documentElement
      const overflow = doc.scrollWidth - doc.clientWidth

      // Anything that overflows the viewport horizontally, ignoring elements
      // inside a container that deliberately scrolls sideways.
      const scrollsSideways = (el) => {
        for (let n = el; n; n = n.parentElement) {
          const o = getComputedStyle(n).overflowX
          if (o === 'auto' || o === 'scroll') return true
        }
        return false
      }
      const wide = []
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        if (r.right > doc.clientWidth + 1 && !scrollsSideways(el)) {
          wide.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().slice(0, 40)} right=${Math.round(r.right)}`)
        }
      }

      const tappable = []
      for (const el of document.querySelectorAll(
        'button, a, [role="button"], input[type="date"], select'
      )) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        if (getComputedStyle(el).display === 'none') continue
        if (r.height < MIN_TAP || r.width < MIN_TAP) {
          tappable.push({
            label: (el.getAttribute('aria-label') || el.textContent || el.tagName)
              .trim()
              .slice(0, 34),
            w: Math.round(r.width),
            h: Math.round(r.height),
          })
        }
      }

      /*
       * Accessible names that are empty, or that have swallowed a whole
       * paragraph. The long case is what a <label> wrapped around a <button>
       * produces: the control announces the entire description instead of its
       * own state.
       */
      const badNames = []
      for (const el of document.querySelectorAll('button, a[href], [role="button"]')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        const name = (
          el.getAttribute('aria-label') ||
          el.textContent ||
          el.getAttribute('title') ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
        if (!name) badNames.push({ why: 'no accessible name', name: el.outerHTML.slice(0, 40) })
        else if (name.length > 80) badNames.push({ why: 'name is a paragraph', name: name.slice(0, 60) })
      }

      const smallInputs = []
      for (const el of document.querySelectorAll('input, select, textarea')) {
        const size = parseFloat(getComputedStyle(el).fontSize)
        if (size < MIN_INPUT_FONT) {
          smallInputs.push({
            type: el.getAttribute('type') || el.tagName.toLowerCase(),
            size: Math.round(size * 10) / 10,
          })
        }
      }

      return { overflow, wide: wide.slice(0, 6), tappable, smallInputs, badNames: badNames.slice(0, 5) }
    },
    { MIN_TAP, MIN_INPUT_FONT }
  )
}

/**
 * WCAG 1.4.3 contrast for every piece of visible text, against the first opaque
 * background behind it. This is what catches a theme that renders one palette's
 * text on the other palette's ground — the classic dark-mode failure.
 */
async function measureContrast(page) {
  return page.evaluate(() => {
    // Tailwind v4 emits colours as lab()/oklch(), which a hand-rolled rgb()
    // regex silently fails to read — so the browser is asked to resolve any CSS
    // colour to sRGB bytes by painting one pixel of it.
    const cvs = document.createElement('canvas')
    cvs.width = cvs.height = 1
    const cx = cvs.getContext('2d', { willReadFrequently: true })
    const cache = new Map()
    const parse = (c) => {
      if (!c || c === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
      if (cache.has(c)) return cache.get(c)
      cx.clearRect(0, 0, 1, 1)
      cx.fillStyle = '#000'
      cx.fillStyle = c
      // An unparseable colour leaves fillStyle at the sentinel, so bail out.
      if (cx.fillStyle === '#000000' && !/^(#000000|black|rgba?\(0, ?0, ?0)/i.test(c)) {
        cache.set(c, null)
        return null
      }
      cx.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = cx.getImageData(0, 0, 1, 1).data
      const out = { r, g, b, a: a / 255 }
      cache.set(c, out)
      return out
    }
    const lum = ({ r, g, b }) => {
      const f = (v) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const ratio = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    }
    const blend = (fg, bg, alpha) => ({
      r: fg.r * alpha + bg.r * (1 - alpha),
      g: fg.g * alpha + bg.g * (1 - alpha),
      b: fg.b * alpha + bg.b * (1 - alpha),
    })

    /** First ancestor with a non-transparent background. */
    const backdrop = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor)
        if (c && c.a > 0.85) return c
      }
      const b = parse(getComputedStyle(document.body).backgroundColor)
      return b && b.a > 0 ? b : { r: 255, g: 255, b: 255, a: 1 }
    }

    const effectiveOpacity = (el) => {
      let o = 1
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        o *= parseFloat(getComputedStyle(n).opacity || '1')
      }
      return o
    }

    const isDisabled = (el) =>
      Boolean(el.closest('[disabled], [aria-disabled="true"], :disabled'))

    const worst = []
    for (const el of document.querySelectorAll('body *')) {
      // Only elements that render their own text, not containers.
      const own = [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .join('')
      if (!own) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none') continue
      // WCAG exempts disabled controls from the contrast minimum.
      if (isDisabled(el)) continue

      const fg = parse(cs.color)
      if (!fg) continue
      const bg = backdrop(el)
      const alpha = Math.min(1, (fg.a ?? 1) * effectiveOpacity(el))
      if (alpha < 0.1) continue

      const size = parseFloat(cs.fontSize)
      const bold = parseInt(cs.fontWeight, 10) >= 700
      const large = size >= 24 || (bold && size >= 18.66)
      const need = large ? 3 : 4.5
      const got = ratio(blend(fg, bg, alpha), bg)

      if (got < need) {
        worst.push({
          text: own.slice(0, 30),
          got: Math.round(got * 100) / 100,
          need,
          size: Math.round(size),
        })
      }
    }
    return worst.sort((a, b) => a.got - b.got).slice(0, 8)
  })
}

async function auditPage(page, label, phone) {
  const m = await measure(page)
  check(
    `${label}: no sideways scroll`,
    m.overflow <= 0,
    m.overflow > 0 ? `${m.overflow}px over; ${m.wide.join(' | ')}` : ''
  )
  check(
    `${label}: every control is at least ${MIN_TAP}px`,
    m.tappable.length === 0,
    m.tappable.map((t) => `"${t.label}" ${t.w}x${t.h}`).join(', ')
  )
  check(
    `${label}: no input below ${MIN_INPUT_FONT}px (iOS zoom)`,
    m.smallInputs.length === 0,
    m.smallInputs.map((i) => `${i.type} ${i.size}px`).join(', ')
  )
  check(
    `${label}: every control has a sane accessible name`,
    m.badNames.length === 0,
    m.badNames.map((b) => `${b.why}: "${b.name}"`).join(' | ')
  )
  const contrast = await measureContrast(page)
  check(
    `${label}: text meets WCAG AA contrast`,
    contrast.length === 0,
    contrast.map((c) => `"${c.text}" ${c.got}:1 (needs ${c.need})`).join(', ')
  )
  if (SHOTS) {
    const slug = `${phone.name.replace(/\s*\([^)]*\)/, '')}-${THEME}-${label}`
      .replace(/[^a-z0-9-]/gi, '_')
      .toLowerCase()
    await page.screenshot({ path: `${SHOT_DIR}/${slug}.png`, fullPage: true })
  }
}

async function main() {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD not set')
  if (SHOTS) await mkdir(SHOT_DIR, { recursive: true })

  // A term with real data so the grid and calendar are not empty shells.
  await resetToRoster()

  const students = await select('students', 'select=id,roll_no&order=s_no.asc')
  const login = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  })
  const adminCookie = (login.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .join('; ')

  const made = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ durationMinutes: 120, windowSeconds: 15 }),
  })
  const session = (await made.json()).session
  const secret = (await one('sessions', `select=secret&id=eq.${session.id}`)).secret
  const token = () =>
    createHmac('sha256', secret)
      .update(`${session.id}:${Math.floor(Date.now() / 1000 / 15)}`)
      .digest('base64url')
      .slice(0, 12)

  // Past classes, so the calendar spans months and the grid shows real marks.
  const past = ['2026-07-03', '2026-07-17', '2026-08-07', '2026-08-14']
  for (const d of past) {
    await fetch(`${BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ classDate: d }),
    })
  }
  const sessionRows = await select('sessions', 'select=id,class_date')

  // One student registers a passkey for real, so /me has a session to render
  // and the roster shows a passkey count. The software authenticator does this
  // over the API — the browser contexts below only need the resulting cookie.
  const studentPhone = phone(BASE)
  await studentPhone.register(session.id, token(), students[0].roll_no)
  const studentCookie = studentPhone.cookie
  for (const row of sessionRows.slice(0, 3)) {
    await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/attendance`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session_id: row.id,
        student_id: students[0].id,
        source: 'manual',
      }),
    })
  }
  // A handful more sign in, so the roster shows a mix of marked and not.
  for (let i = 1; i < 12; i++) {
    const p = phone(BASE)
    await p.register(session.id, token(), students[i].roll_no)
  }

  const origin = new URL(BASE).origin

  /**
   * Waits for a control that must be there, and records a failure if it is not.
   *
   * Every admin screen below used to be behind a bare `isVisible()`, which polls
   * once and returns false if React has not rendered yet. A missing control
   * therefore skipped its screen in silence — indistinguishable, in the output,
   * from a screen that passed. Waiting turns a slow host into a pass, and a
   * genuinely absent control into a failure, which is what it is.
   */
  async function mustSee(locator, what, timeout = 15000) {
    try {
      await locator.waitFor({ state: 'visible', timeout })
      return true
    } catch {
      check(`${what}: the control that opens it is on screen`, false, 'never appeared')
      return false
    }
  }

  /**
   * Leaves the More panel open, whatever state it is in now.
   *
   * `More` is a toggle and the panels are exclusive, so the blind
   * click-to-open / click-to-close pairs this file used to do drifted out of
   * step: opening the add-student form switched the panel, the closing click
   * re-opened More, and the next section's opening click shut it again. Manage
   * was therefore never on screen, and the temporary-access screens were skipped
   * on every device and both themes — silently, because the guard was a bare
   * isVisible(). Asserting the state instead of counting clicks fixes the class
   * of bug, not just this instance.
   */
  async function ensureMoreOpen(page) {
    const marker = page.getByText('Temporary access').first()
    if (await marker.isVisible().catch(() => false)) return true
    const more = page.getByRole('button', { name: 'More', exact: true }).first()
    if (!(await mustSee(more, 'more'))) return false
    await more.click()
    await page.waitForTimeout(350)
    return true
  }

  console.log(`\ntheme under test: ${THEME}`)
  for (const phone of PHONES) {
    const browserType = phone.engine === 'webkit' ? webkit : chromium
    const browser = await browserType.launch()
    console.log(`\n  ${phone.name} — ${phone.engine === 'webkit' ? 'iOS Safari' : 'Android Chrome'}`)

    const context = await browser.newContext({
      ...phone.preset,
      colorScheme: THEME === 'light' ? 'light' : 'dark',
    })
    // The app stores the choice; set it so the pre-paint script resolves to the
    // theme under test rather than whatever the device reports.
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('att_theme', t)
      } catch {}
    }, THEME)
    await context.addCookies([
      {
        name: 'att_admin',
        value: adminCookie.replace('att_admin=', ''),
        domain: COOKIE_DOMAIN,
        path: '/',
      },
    ])
    // The passkey session, so /me renders a real record. There is nothing to
    // put in localStorage any more: identity lives in the OS keychain, and this
    // cookie only grants reading their own page.
    if (studentCookie) {
      await context.addCookies([
        {
          name: 'att_student',
          value: studentCookie.replace('att_student=', ''),
          domain: COOKIE_DOMAIN,
          path: '/',
        },
      ])
    }

    const page = await context.newPage()

    // Landing page.
    await page.goto(`${origin}/`, { waitUntil: 'networkidle' })
    await auditPage(page, 'home', phone)

    // The sign-in page, in a context with no admin cookie — it was never
    // measured while the audit signed itself in first.
    const anon = await browser.newContext({
      ...phone.preset,
      colorScheme: THEME === 'light' ? 'light' : 'dark',
    })
    await anon.addInitScript((t) => {
      try {
        window.localStorage.setItem('att_theme', t)
      } catch {}
    }, THEME)
    const anonPage = await anon.newPage()
    await anonPage.goto(`${origin}/admin`, { waitUntil: 'networkidle' })
    await auditPage(anonPage, 'login', phone)
    // Password revealed: the eye swaps the input type, so re-measure.
    await anonPage.getByRole('button', { name: 'Show password' }).click()
    await anonPage.waitForTimeout(200)
    await auditPage(anonPage, 'login-revealed', phone)
    await anonPage.goto(`${origin}/offline.html`, { waitUntil: 'networkidle' })
    await auditPage(anonPage, 'offline', phone)
    await anon.close()

    // Student scan result.
    await page.goto(`${origin}/m?s=${session.id}&t=${token()}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(400)
    await auditPage(page, 'scan', phone)

    // Student calendar.
    await page.goto(`${origin}/me`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/Present|class/i', { timeout: 8000 }).catch(() => {})
    await auditPage(page, 'calendar', phone)

    // Admin roster grid.
    await page.goto(`${origin}/admin`, { waitUntil: 'networkidle' })
    await page.waitForSelector('li', { timeout: 8000 }).catch(() => {})
    await auditPage(page, 'roster', phone)

    // Every admin panel open, since they hold the densest controls.
    for (const [label, button] of [
      ['session-setup', 'Extend / stop'],
      ['export', 'Download .xlsx'],
      ['more', 'More'],
    ]) {
      const btn = page.getByRole('button', { name: button, exact: false }).first()
      if (await mustSee(btn, label)) {
        await btn.click()
        await page.waitForTimeout(250)
        await auditPage(page, label, phone)
        await btn.click().catch(() => {})
        await page.waitForTimeout(150)
      }
    }

    // The add-student form.
    if (await ensureMoreOpen(page)) {
      const addBtn = page.getByRole('button', { name: 'Add student' }).first()
      if (await mustSee(addBtn, 'add-student')) {
        await addBtn.click()
        await page.waitForTimeout(300)
        await auditPage(page, 'add-student', phone)
      }
    }

    // Temporary access, which holds the roster picker.
    if (await ensureMoreOpen(page)) {
      const manage = page.getByRole('button', { name: 'Manage' }).first()
      if (await mustSee(manage, 'access')) {
        await manage.click()
        await page.waitForTimeout(300)
        await auditPage(page, 'access', phone)
        // With search results open, which is the tallest state.
        const search = page.getByPlaceholder(/Search the roster/)
        if (await mustSee(search, 'access-results')) {
          await search.fill('a')
          await page.waitForTimeout(300)
          await auditPage(page, 'access-results', phone)
          await search.fill('')
        }
      }
    }

    // The confirm dialog, which only appears for a scanned student.
    const scannedMenu = page.locator('button[aria-label^="More actions"]').first()
    if (await mustSee(scannedMenu, 'confirm-dialog (row menu)')) {
      await scannedMenu.click()
      await page.waitForTimeout(250)
      const unmark = page.locator('button', { hasText: /^Unmark$/ }).first()
      if (await mustSee(unmark, 'confirm-dialog (Unmark)')) {
        await unmark.click()
        await page.waitForTimeout(400)
        if (await mustSee(page.locator('[role=dialog]'), 'confirm-dialog')) {
          await auditPage(page, 'confirm-dialog', phone)
          await page.locator('button', { hasText: /^Keep it$/ }).click()
          await page.waitForTimeout(250)
        }
      }
    }

    // Staged selection, which puts the save bar on screen.
    const selectAll = page.locator('button', { hasText: /^Select all/ }).first()
    if (await mustSee(selectAll, 'staged-save-bar')) {
      await selectAll.click()
      await page.waitForTimeout(300)
      await auditPage(page, 'staged-save-bar', phone)
      const discard = page.locator('button', { hasText: /^Discard$/ }).first()
      if (await discard.isVisible().catch(() => false)) await discard.click()
      await page.waitForTimeout(200)
    }

    // The fullscreen QR must fit without cropping.
    const qr = page.getByRole('button', { name: 'Show QR' }).first()
    if (await mustSee(qr, 'qr')) {
      await qr.click()
      await page.waitForTimeout(1200)
      const img = page.locator('img[alt="Attendance QR code"]')
      if (await mustSee(img, 'qr (the code itself)')) {
        const box = await img.boundingBox()
        const vp = page.viewportSize()
        check(
          `qr: fits inside the screen`,
          box.width <= vp.width && box.height <= vp.height,
          `${Math.round(box.width)}x${Math.round(box.height)} in ${vp.width}x${vp.height}`
        )
        check(`qr: large enough to scan from a desk`, box.width >= vp.width * 0.5,
          `${Math.round(box.width)}px of ${vp.width}px`)
      }
      await auditPage(page, 'qr', phone)
    }

    await context.close()
    await browser.close()
  }

  // ── PWA installability ────────────────────────────────────────────────────
  console.log('\n  PWA installability')
  const browser = await chromium.launch()
  const context = await browser.newContext({ ...devices['Pixel 7'] })
  const page = await context.newPage()
  await page.goto(`${new URL(BASE).origin}/`, { waitUntil: 'networkidle' })

  const head = await page.evaluate(() => ({
    manifestHref: document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null,
    themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
    appleIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') ?? null,
    appleCapable:
      document
        .querySelector('meta[name="apple-mobile-web-app-capable"]')
        ?.getAttribute('content') ??
      document
        .querySelector('meta[name="mobile-web-app-capable"]')
        ?.getAttribute('content') ??
      null,
    viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? null,
  }))

  const resolved = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    scheme: getComputedStyle(document.documentElement).colorScheme,
    bg: getComputedStyle(document.body).backgroundColor,
  }))
  check(
    'the theme resolves to an explicit attribute before paint',
    resolved.attr === 'light' || resolved.attr === 'dark',
    JSON.stringify(resolved)
  )
  check(
    'color-scheme is set so native controls follow the theme',
    resolved.scheme === resolved.attr,
    JSON.stringify(resolved)
  )

  check('a web app manifest is linked', head.manifestHref !== null, JSON.stringify(head.manifestHref))
  check('a theme colour is declared', head.themeColor !== null)
  check('an apple-touch-icon exists (iOS home screen)', head.appleIcon !== null)
  check('standalone display is declared for iOS', head.appleCapable !== null)
  check(
    'pinch-zoom is not blocked',
    head.viewport !== null &&
      !/maximum-scale\s*=\s*1(\.0)?\b/.test(head.viewport) &&
      !/user-scalable\s*=\s*no/.test(head.viewport),
    head.viewport ?? 'no viewport meta'
  )

  if (head.manifestHref) {
    const res = await page.request.get(new URL(head.manifestHref, BASE).href)
    check('the manifest is served', res.ok(), `HTTP ${res.status()}`)
    if (res.ok()) {
      const m = await res.json().catch(() => null)
      check('manifest declares a name', Boolean(m?.name || m?.short_name))
      check('manifest sets display standalone', m?.display === 'standalone')
      check('manifest has a start_url', Boolean(m?.start_url))
      const sizes = (m?.icons ?? []).map((i) => i.sizes)
      check('manifest has a 192px icon', sizes.some((s) => String(s).includes('192')), sizes.join(','))
      check('manifest has a 512px icon', sizes.some((s) => String(s).includes('512')), sizes.join(','))
      for (const icon of m?.icons ?? []) {
        const r = await page.request.get(new URL(icon.src, BASE).href)
        check(`icon ${icon.sizes} is served`, r.ok(), `HTTP ${r.status()}`)
      }
    }
  }

  if (head.appleIcon) {
    const r = await page.request.get(new URL(head.appleIcon, BASE).href)
    check('the apple-touch-icon is served', r.ok(), `HTTP ${r.status()}`)
  }

  await context.close()
  await browser.close()

  console.log(`\n${'='.repeat(60)}`)
  console.log(`${pass} passed, ${fail} failed`)
  if (failures.length) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f}`)
  }

  // A build that fails to serve a screen used to make this audit *shorter*, not
  // red: fewer screens reached means fewer checks run, and "0 failed" over half
  // the matrix reads exactly like a pass. Assert the floor so a broken build is
  // a failure rather than a quiet omission.
  //
  // It has now earned its keep twice. It caught a build serving 500ing chunks,
  // and it caught this file setting its cookies on `domain: 'localhost'` while
  // pointed at production — 227 checks passed against the login page, seven
  // admin screens skipped in silence. The guards those screens sat behind are
  // now mustSee(), so a missing control fails instead of vanishing; the floor
  // stays as the backstop for whatever the next silent skip turns out to be.
  const FLOOR = 500
  let short = false
  if (pass + fail < FLOOR) {
    short = true
    console.log(
      `\nTOO FEW CHECKS: ran ${pass + fail}, expected at least ${FLOOR}. ` +
        'Screens were probably unreachable — treat this as a failure, not a pass.'
    )
  }
  console.log('='.repeat(60))
  process.exit(fail === 0 && !short ? 0 : 1)
}

main().catch((e) => {
  console.error('\nmobile audit crashed:', e)
  process.exit(1)
})
