import { fail, isUuid, ok, readJson, guardAdmin } from '@/lib/api'
import {
  DEFAULT_SESSION_MINUTES,
  audit,
  getSessionById,
  isValidSessionMinutes,
  toPublicSession,
} from '@/lib/data'
import { actorOf } from '@/lib/admin'
import { classDate } from '@/lib/dates'
import { db } from '@/lib/supabase'
import { isValidWindowSeconds } from '@/lib/token'

/**
 * Stop, extend or resume a session, and adjust its QR rotation.
 *
 * - `open: false` ends it now. `expires_at` is pulled back to the present so the
 *   remaining-time readout tells the truth rather than counting down a session
 *   nobody can scan.
 * - `open: true` on a session that is still live **extends** it: the added
 *   minutes are stacked on the existing expiry, not measured from now, so
 *   extending twice adds twice.
 * - `open: true` on one that has lapsed resumes it from now.
 */
export async function POST(req: Request) {
  const guard = await guardAdmin()
  if (!guard.ok) return guard.response

  const body = await readJson(req)
  const { sessionId, open } = body as { sessionId?: string; open?: boolean }
  if (!isUuid(sessionId) || typeof open !== 'boolean') return fail('BAD_REQUEST')

  // Absent `minutes` means "leave the end time alone" — that is how a
  // rotation-only change avoids having to restate the duration.
  const hasMinutes = body.minutes !== undefined && body.minutes !== null
  if (open && hasMinutes && !isValidSessionMinutes(body.minutes)) return fail('BAD_DURATION')
  const minutes = hasMinutes ? (body.minutes as number) : DEFAULT_SESSION_MINUTES

  const changingWindow = body.windowSeconds !== undefined && body.windowSeconds !== null
  if (changingWindow && !isValidWindowSeconds(body.windowSeconds)) return fail('BAD_WINDOW')

  const session = await getSessionById(sessionId)
  if (!session) return fail('NO_SESSION', 404)

  const now = Date.now()
  const currentExpiry = new Date(session.expires_at).getTime()
  const stillLive = session.is_open && currentExpiry > now

  // A past day has no live QR by design, so a lapsed or backdated session can
  // only be opened on its own date. A session that is *still running* is exempt:
  // an evening class that crosses midnight must remain extendable, and by then
  // its class_date is legitimately yesterday.
  if (open && !stillLive && session.class_date !== classDate()) {
    return fail('NOT_TODAY', 409)
  }

  let expiresAt: string
  if (!open) {
    expiresAt = new Date(now).toISOString()
  } else if (hasMinutes) {
    expiresAt = new Date((stillLive ? currentExpiry : now) + minutes * 60_000).toISOString()
  } else if (stillLive) {
    expiresAt = session.expires_at
  } else {
    expiresAt = new Date(now + minutes * 60_000).toISOString()
  }

  const { data, error } = await db()
    .from('sessions')
    .update({
      is_open: open,
      expires_at: expiresAt,
      // Changing the period invalidates every token already on screen. That is
      // intentional — the next poll redraws the QR within one old period.
      ...(changingWindow ? { window_seconds: body.windowSeconds as number } : {}),
    })
    .eq('id', sessionId)
    .select('*')
    .single()
  if (error) throw error

  const parts: string[] = []
  if (!open) parts.push('ended')
  else if (hasMinutes) parts.push(`${stillLive ? 'extended' : 'resumed'} by ${minutes} min`)
  else if (!stillLive) parts.push(`resumed by ${minutes} min`)
  if (changingWindow) parts.push(`QR now every ${body.windowSeconds}s`)
  const detail = parts.join(', ') || 'unchanged'

  await audit({
    action: open ? 'OPEN_SESSION' : 'CLOSE_SESSION',
    sessionId,
    reason: detail,
    actor: actorOf(guard.principal),
  })
  return ok({ session: toPublicSession(data), extended: open && stillLive })
}
