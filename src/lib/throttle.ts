import { db } from './supabase'

const WINDOW_MS = 15 * 60_000
const MAX_ATTEMPTS = 10

/**
 * Failed-login throttling for the one shared admin credential.
 *
 * A row per failure rather than a counter, which makes the whole thing a matter
 * of inserts and counts. The previous version kept a JSON blob in `settings` and
 * updated it read-modify-write, so two failures arriving together could each
 * overwrite the other's count — precisely the case throttling exists to catch.
 *
 * Kept in Postgres rather than memory because the app runs serverless: process
 * memory is per-instance and short-lived, so an in-memory counter would barely
 * inconvenience an attacker.
 */

/** The caller's address, as far as the platform will tell us. */
export function callerKey(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return req.headers.get('x-real-ip')?.trim() || 'unknown'
}

export type ThrottleState = { blocked: boolean; retryAfterSeconds: number }

export async function checkThrottle(key: string): Promise<ThrottleState> {
  const since = new Date(Date.now() - WINDOW_MS).toISOString()
  const { data, error } = await db()
    .from('login_attempts')
    .select('at')
    .eq('caller', key)
    .gte('at', since)
    .order('at', { ascending: true })
  if (error) throw error

  const attempts = data ?? []
  if (attempts.length < MAX_ATTEMPTS) return { blocked: false, retryAfterSeconds: 0 }

  // Blocked until the oldest attempt in the window ages out.
  const oldest = new Date(attempts[0].at).getTime()
  return {
    blocked: true,
    retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - Date.now()) / 1000)),
  }
}

export async function recordFailure(key: string): Promise<void> {
  const { error } = await db().from('login_attempts').insert({ caller: key })
  if (error) {
    console.error('login_attempts insert failed', error)
    return
  }
  // Opportunistic tidy-up, so the table cannot grow without bound.
  await db()
    .from('login_attempts')
    .delete()
    .lt('at', new Date(Date.now() - WINDOW_MS).toISOString())
}

/** A correct credential clears that address's history. */
export async function clearFailures(key: string): Promise<void> {
  const { error } = await db().from('login_attempts').delete().eq('caller', key)
  if (error) console.error('login_attempts clear failed', error)
}
