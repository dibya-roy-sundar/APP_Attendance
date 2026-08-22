/**
 * Load test shaped like the real thing: a class of 47 all scanning at once,
 * while the instructor's grid polls and the QR rotates.
 *
 *   set -a; . ./.env.local; set +a
 *   node test/local/load.mjs
 */
import { createHmac } from 'node:crypto'
import { count, one, patch, remove, resetToRoster, select } from './db.mjs'
import { phone } from './student.mjs'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3100'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
const WINDOW = 15

const tokenFor = (secret, sid, w) =>
  createHmac('sha256', secret).update(`${sid}:${w}`).digest('base64url').slice(0, 12)
const nowWindow = (p = WINDOW) => Math.floor(Date.now() / 1000 / p)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function stats(ms) {
  if (!ms.length) return { n: 0 }
  const s = [...ms].sort((a, b) => a - b)
  const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))]
  return {
    n: s.length,
    p50: at(0.5),
    p95: at(0.95),
    max: s[s.length - 1],
    mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  }
}

function report(name, results, elapsed) {
  const byOutcome = new Map()
  const lat = []
  for (const r of results) {
    byOutcome.set(r.outcome, (byOutcome.get(r.outcome) ?? 0) + 1)
    lat.push(r.ms)
  }
  const s = stats(lat)
  console.log(`\n  ${name}`)
  console.log(
    `    ${results.length} requests in ${elapsed}ms  ` +
      `(${Math.round((results.length / elapsed) * 1000)}/s)`
  )
  console.log(`    latency  p50 ${s.p50}ms · p95 ${s.p95}ms · max ${s.max}ms · mean ${s.mean}ms`)
  for (const [outcome, n] of [...byOutcome].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)} × ${outcome}`)
  }
  return byOutcome
}

async function timed(fn) {
  const t0 = performance.now()
  try {
    const outcome = await fn()
    return { outcome, ms: Math.round(performance.now() - t0) }
  } catch (e) {
    return { outcome: `threw: ${e.message}`, ms: Math.round(performance.now() - t0) }
  }
}

async function post(path, body, cookie) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

async function main() {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD not set')
  console.log(`\ntarget: ${BASE}`)

  // ── reset ───────────────────────────────────────────────────────────────
  await remove('admin_grants', 'id=not.is.null')
  await resetToRoster()

  const students = await select('students', 'select=roll_no&order=s_no.asc')
  const rolls = students.map((s) => s.roll_no)
  console.log(`roster: ${rolls.length} students, enrollment open`)

  const login = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  })
  const admin = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')

  const created = await post(
    '/api/sessions',
    { durationMinutes: 120, windowSeconds: 15 },
    admin
  )
  const session = created.data.session
  const secret = (await one('sessions', `select=secret&id=eq.${session.id}`)).secret
  // One phone per student, each with its own keychain — which is what makes 47
  // concurrent sign-ins genuinely 47 separate signing operations rather than
  // one shared secret replayed.
  const phones = rolls.map(() => phone(BASE))

  console.log('═'.repeat(64))
  console.log('SCENARIO 1 — first class: all 47 enroll simultaneously')
  let t0 = Date.now()
  const t = tokenFor(secret, session.id, nowWindow())
  const enrollResults = await Promise.all(
    rolls.map((rollNo, i) =>
      timed(async () => {
        const r = await phones[i].register(session.id, t, rollNo)
        return r.data.status ?? r.data.error ?? `http ${r.status}`
      })
    )
  )
  report('47 concurrent passkey registrations', enrollResults, Date.now() - t0)
  console.log(`    attendance rows now: ${await count('attendance')}`)
  console.log(`    passkeys registered: ${await count('student_credentials')}`)

  console.log('\n' + '═'.repeat(64))
  console.log('SCENARIO 2 — every later class: all 47 scan within one window')
  await remove('attendance', 'session_id=not.is.null')
  t0 = Date.now()
  const t2 = tokenFor(secret, session.id, nowWindow())
  const markResults = await Promise.all(
    phones.map((p) =>
      timed(async () => {
        const r = await p.markPresent(session.id, t2)
        return r.data.status ?? r.data.error ?? `http ${r.status}`
      })
    )
  )
  report('47 concurrent passkey sign-ins', markResults, Date.now() - t0)
  console.log(`    attendance rows: ${await count('attendance')} (expect 47)`)

  console.log('\n' + '═'.repeat(64))
  console.log('SCENARIO 3 — impatient students: everyone double-taps')
  t0 = Date.now()
  const t3 = tokenFor(secret, session.id, nowWindow())
  const dupResults = await Promise.all(
    phones.flatMap((p) =>
      [1, 2, 3].map(() =>
        timed(async () => {
          const r = await p.markPresent(session.id, t3)
          return r.data.status ?? r.data.error ?? `http ${r.status}`
        })
      )
    )
  )
  report('141 requests (47 students × 3 taps)', dupResults, Date.now() - t0)
  console.log(`    attendance rows: ${await count('attendance')} (must still be 47)`)

  console.log('\n' + '═'.repeat(64))
  console.log('SCENARIO 4 — scans landing while the grid polls and the QR rotates')
  await remove('attendance', 'session_id=not.is.null')
  t0 = Date.now()
  const mixed = await Promise.all([
    ...phones.map((p) =>
      timed(async () => {
        const r = await p.markPresent(session.id, tokenFor(secret, session.id, nowWindow()))
        return r.data.status ?? r.data.error ?? `http ${r.status}`
      })
    ),
    ...Array.from({ length: 8 }, () =>
      timed(async () => {
        const res = await fetch(`${BASE}/api/roster?s=${session.id}`, {
          headers: { cookie: admin },
        })
        if (!res.ok) return `roster http ${res.status}`
        const d = await res.json()
        return `roster ok (${d.markedCount} marked)`
      })
    ),
    ...Array.from({ length: 8 }, () =>
      timed(async () => {
        const res = await fetch(`${BASE}/api/token?s=${session.id}`, {
          headers: { cookie: admin },
        })
        return res.ok ? 'token ok' : `token http ${res.status}`
      })
    ),
  ])
  report('47 scans + 8 roster polls + 8 token polls', mixed, Date.now() - t0)
  console.log(`    attendance rows: ${await count('attendance')} (expect 47)`)

  console.log('\n' + '═'.repeat(64))
  console.log('SCENARIO 5 — a full term of exports, back to back')
  // Give the term some history so the export has real work to do.
  for (let i = 1; i <= 15; i++) {
    const d = `2026-0${i < 10 ? '4' : '5'}-${String((i % 28) + 1).padStart(2, '0')}`
    await fetch(`${BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: admin },
      body: JSON.stringify({ classDate: d }),
    })
  }
  const sessionCount = await count('sessions')
  t0 = Date.now()
  const exports = await Promise.all(
    Array.from({ length: 10 }, () =>
      timed(async () => {
        const res = await fetch(`${BASE}/api/export`, { headers: { cookie: admin } })
        if (!res.ok) return `http ${res.status}`
        const buf = await res.arrayBuffer()
        return `xlsx ${Math.round(buf.byteLength / 1024)}KB`
      })
    )
  )
  report(`10 concurrent exports over ${sessionCount} classes`, exports, Date.now() - t0)

  console.log('\n' + '═'.repeat(64))
  console.log('SCENARIO 6 — sustained: 5 waves of 47 scans, 1s apart')
  const waveLatencies = []
  for (let wave = 1; wave <= 5; wave++) {
    const tw = tokenFor(secret, session.id, nowWindow())
    const t1 = Date.now()
    const r = await Promise.all(
      phones.map((p) =>
        timed(async () => {
          const res = await p.markPresent(session.id, tw)
          return res.data.status ?? res.data.error ?? `http ${res.status}`
        })
      )
    )
    const s = stats(r.map((x) => x.ms))
    const bad = r.filter((x) => x.outcome !== 'MARKED').length
    waveLatencies.push(s.p50)
    console.log(
      `    wave ${wave}: ${Date.now() - t1}ms wall · p50 ${s.p50}ms · p95 ${s.p95}ms · ` +
        `${bad === 0 ? 'all marked' : `${bad} NOT marked`}`
    )
    await sleep(1000)
  }
  const drift = waveLatencies[4] - waveLatencies[0]
  console.log(
    `    p50 drift across waves: ${drift >= 0 ? '+' : ''}${drift}ms ` +
      `(${Math.abs(drift) < 150 ? 'stable' : 'DEGRADING'})`
  )

  console.log('\n' + '═'.repeat(64))
  const finalRows = await count('attendance')
  const auditRows = await count('audit_log')
  console.log(`final: ${finalRows} attendance rows, ${auditRows} audit entries`)
  console.log('═'.repeat(64) + '\n')
}

main().catch((e) => {
  console.error('load test crashed:', e)
  process.exit(1)
})
