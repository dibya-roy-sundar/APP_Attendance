import { db } from './supabase'

const KEY = 'login_throttle'
const WINDOW_MS = 15 * 60_000
const MAX_ATTEMPTS = 10
/** Bounds the stored blob so a spray from many addresses cannot grow it forever. */
const MAX_TRACKED = 200

type Buckets = Record<string, number[]>

/**
 * Failed-login throttling for the one shared admin credential.
 *
 * Kept in `settings` rather than in memory because the app runs serverless:
 * process memory is per-instance and short-lived, so an in-memory counter would
 * barely slow an attacker down. A lost update under concurrency only ever lets a
 * few extra attempts through, which is an acceptable trade for needing no
 * schema change.
 */
async function read(): Promise<Buckets> {
  const { data, error } = await db()
    .from('settings')
    .select('value')
    .eq('key', KEY)
    .maybeSingle()
  if (error) throw error
  if (!data?.value) return {}
  try {
    const parsed = JSON.parse(data.value)
    return parsed && typeof parsed === 'object' ? (parsed as Buckets) : {}
  } catch {
    return {}
  }
}

async function write(buckets: Buckets): Promise<void> {
  const { error } = await db()
    .from('settings')
    .upsert({ key: KEY, value: JSON.stringify(buckets) }, { onConflict: 'key' })
  if (error) console.error('throttle write failed', error)
}

function prune(buckets: Buckets, now: number): Buckets {
  const out: Buckets = {}
  const entries = Object.entries(buckets)
    .map(([ip, times]) => [ip, times.filter((t) => now - t < WINDOW_MS)] as const)
    .filter(([, times]) => times.length > 0)
    // Keep the most recently active addresses if we are at the cap.
    .sort((a, b) => Math.max(...b[1]) - Math.max(...a[1]))
    .slice(0, MAX_TRACKED)
  for (const [ip, times] of entries) out[ip] = times
  return out
}

/** The caller's address, as far as the platform will tell us. */
export function callerKey(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers.get('x-real-ip')?.trim() || 'unknown'
}

export type ThrottleState = { blocked: boolean; retryAfterSeconds: number }

export async function checkThrottle(key: string): Promise<ThrottleState> {
  const now = Date.now()
  const buckets = prune(await read(), now)
  const times = buckets[key] ?? []
  if (times.length < MAX_ATTEMPTS) return { blocked: false, retryAfterSeconds: 0 }
  const oldest = Math.min(...times)
  return {
    blocked: true,
    retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)),
  }
}

export async function recordFailure(key: string): Promise<void> {
  const now = Date.now()
  const buckets = prune(await read(), now)
  buckets[key] = [...(buckets[key] ?? []), now]
  await write(buckets)
}

/** A correct credential clears that address's history. */
export async function clearFailures(key: string): Promise<void> {
  const now = Date.now()
  const buckets = prune(await read(), now)
  if (!(key in buckets)) return
  delete buckets[key]
  await write(buckets)
}
