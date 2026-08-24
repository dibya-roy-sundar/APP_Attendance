/**
 * The harness's direct database access, over the same REST surface the app uses.
 * Supabase exposes no psql endpoint, so every setup/assertion query goes through
 * PostgREST with the service role key.
 */
const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  throw new Error(
    'Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (e.g. `set -a; . ./.env.local; set +a`).'
  )
}

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
}

async function rest(path, init = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

export const select = (table, query = '') => rest(`${table}?${query}`)

/**
 * There is one Supabase project, so these suites write to the same database the
 * class uses. Every harness here opens by deleting attendance and nulling every
 * passkey, which on a teaching day destroys the real register — and the
 * .xlsx export is the only copy of it.
 *
 * So a destructive call has to be asked for out loud:
 *
 *   ATT_ALLOW_DB_WIPE=1 node test/local/e2e.mjs
 *
 * Guarding the helper rather than each suite means a new harness inherits the
 * protection instead of having to remember it.
 */
const WIPE_ALLOWED = process.env.ATT_ALLOW_DB_WIPE === '1'
const projectRef = (url.match(/https:\/\/([a-z0-9]+)\.supabase/) ?? [, url])[1]
let warned = false

function assertWipeAllowed(verb, table, query) {
  if (WIPE_ALLOWED) {
    if (!warned) {
      warned = true
      console.log(
        [
          '',
          `  WARNING: writing to Supabase project ${projectRef} — the database production uses.`,
          '  Attendance, sessions, passkeys and audit history in it will be destroyed.',
          '',
        ].join('\n')
      )
    }
    return
  }
  throw new Error(
    [
      `Refusing to ${verb} ${table} (${query}).`,
      '',
      `  This talks to Supabase project ${projectRef}, which is the database`,
      '  production uses. Running this suite deletes real attendance, and the',
      '  .xlsx export is the only backup.',
      '',
      '  If that is genuinely what you want:',
      '    ATT_ALLOW_DB_WIPE=1 node <suite>',
      '',
      '  Never on a teaching day. Export the register first.',
    ].join('\n')
  )
}

export const patch = (table, query, body) => {
  assertWipeAllowed('PATCH', table, query)
  return rest(`${table}?${query}`, { method: 'PATCH', body: JSON.stringify(body) })
}

export const remove = (table, query) => {
  assertWipeAllowed('DELETE', table, query)
  return rest(`${table}?${query}`, { method: 'DELETE' })
}

/**
 * Writes a row directly, for setting up a state the app cannot reach quickly —
 * a request that is already weeks old, say. Guarded like the others: it
 * writes to the same database production uses.
 */
export const insert = (table, body) => {
  assertWipeAllowed('INSERT', table, JSON.stringify(body).slice(0, 60))
  return rest(table, { method: 'POST', body: JSON.stringify(body) })
}

export async function count(table, query = '') {
  const rows = await select(table, query ? `select=*&${query}` : 'select=*')
  return rows.length
}

/** One column of one row, or undefined. */
export async function one(table, query) {
  const rows = await select(table, query)
  return rows[0]
}

/**
 * Back to nothing but the roster: 47 students, no passkeys, no history.
 *
 * Every suite opened with its own list of tables to clear, and each time the
 * schema changed those lists drifted apart — one of them was still nulling
 * students.device_id after that column was dropped. The list lives here now, so
 * a schema change is one edit.
 *
 * Children before parents, or the foreign keys refuse. Students themselves are
 * never deleted: they come from "Soft Skills.xlsx" via `npm run seed`, and a
 * suite that had to re-seed would be far slower and could reorder s_no.
 */
export async function resetToRoster() {
  await remove('webauthn_challenges', 'challenge=not.is.null')
  // Decided requests are deliberately kept for a week in production —
  // a refused claim is evidence of an attempted proxy. A test reset clears
  // them anyway, or counts carry over between suites.
  await remove('passkey_requests', 'id=not.is.null')
  await remove('student_credentials', 'id=not.is.null')
  await remove('attendance', 'session_id=not.is.null')
  await remove('audit_log', 'id=gt.0')
  await remove('login_attempts', 'id=gt.0')
  await remove('admin_grants', 'id=not.is.null')
  await remove('sessions', 'id=not.is.null')
  // Students added by a test, which the spreadsheet does not contain.
  await remove('students', 's_no=gt.47')
}

/** What a suite should see before it starts, and leave behind when it ends. */
export async function rosterOnly() {
  return {
    students: await count('students'),
    credentials: await count('student_credentials'),
    attendance: await count('attendance'),
    sessions: await count('sessions'),
  }
}
