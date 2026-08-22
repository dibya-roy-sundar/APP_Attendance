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
 * device binding, which on a teaching day destroys the real register — and the
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
          '  Attendance, sessions and device bindings in it are about to be destroyed.',
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

export async function count(table, query = '') {
  const rows = await select(table, query ? `select=*&${query}` : 'select=*')
  return rows.length
}

/** One column of one row, or undefined. */
export async function one(table, query) {
  const rows = await select(table, query)
  return rows[0]
}
