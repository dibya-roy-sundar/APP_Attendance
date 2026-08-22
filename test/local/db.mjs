/**
 * The harness's direct database access, over the same REST surface the app uses.
 * Supabase exposes no psql endpoint, so every setup/assertion query goes through
 * PostgREST with the service role key.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
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

export const patch = (table, query, body) =>
  rest(`${table}?${query}`, { method: 'PATCH', body: JSON.stringify(body) })

export const remove = (table, query) =>
  rest(`${table}?${query}`, { method: 'DELETE' })

export async function count(table, query = '') {
  const rows = await select(table, query ? `select=*&${query}` : 'select=*')
  return rows.length
}

/** One column of one row, or undefined. */
export async function one(table, query) {
  const rows = await select(table, query)
  return rows[0]
}
