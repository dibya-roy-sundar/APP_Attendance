import { fail, ok, readJson, guardAdmin } from '@/lib/api'
import {
  DEFAULT_SESSION_MINUTES,
  audit,
  getSessionByDate,
  isValidSessionMinutes,
  listSessions,
  newSecret,
  toPublicSession,
} from '@/lib/data'
import { actorOf } from '@/lib/admin'
import { classDate, isValidDateString } from '@/lib/dates'
import { db } from '@/lib/supabase'
import { DEFAULT_WINDOW_SECONDS, isValidWindowSeconds } from '@/lib/token'

export async function GET() {
  const guard = await guardAdmin()
  if (!guard.ok) return guard.response
  const sessions = await listSessions()
  return ok({ sessions: sessions.map(toPublicSession), today: classDate() })
}

/**
 * Starts a session.
 *
 * With no `classDate` this is today's live session, running for
 * `durationMinutes` and rotating its QR every `windowSeconds`. With a past
 * `classDate` it is a backdated one: `is_open = false`, so no QR is ever
 * generated for it and every mark lands as manual.
 */
export async function POST(req: Request) {
  const guard = await guardAdmin()
  if (!guard.ok) return guard.response

  const body = await readJson(req)
  const today = classDate()
  const date = body.classDate === undefined || body.classDate === null ? today : body.classDate

  if (!isValidDateString(date)) return fail('BAD_DATE')
  if (date > today) return fail('FUTURE_DATE')

  const minutes = body.durationMinutes ?? DEFAULT_SESSION_MINUTES
  if (!isValidSessionMinutes(minutes)) return fail('BAD_DURATION')

  const windowSeconds = body.windowSeconds ?? DEFAULT_WINDOW_SECONDS
  if (!isValidWindowSeconds(windowSeconds)) return fail('BAD_WINDOW')

  const backdated = date < today

  // Offer the existing session rather than refusing flatly — the admin's intent
  // is "get me to this day's grid", and a second session for one day would
  // silently split the roll.
  const existing = await getSessionByDate(date)
  if (existing) {
    return fail('DATE_HAS_SESSION', 409, { session: toPublicSession(existing) })
  }

  const now = new Date()
  const expiresAt = backdated
    ? now // never scannable
    : new Date(now.getTime() + minutes * 60_000)

  const { data, error } = await db()
    .from('sessions')
    .insert({
      class_date: date,
      secret: newSecret(),
      is_open: !backdated,
      expires_at: expiresAt.toISOString(),
      window_seconds: windowSeconds,
    })
    .select('*')
    .single()
  if (error) {
    // Two admins tapping Start at once; the unique index on class_date wins.
    if ((error as { code?: string }).code === '23505') {
      const raced = await getSessionByDate(date)
      if (raced) return fail('DATE_HAS_SESSION', 409, { session: toPublicSession(raced) })
    }
    throw error
  }

  await audit({
    action: backdated ? 'START_BACKDATED_SESSION' : 'START_SESSION',
    sessionId: data.id,
    actor: actorOf(guard.principal),
    reason: backdated
      ? `backdated to ${date}`
      : `${minutes} min, QR rotating every ${windowSeconds}s`,
  })
  return ok({ session: toPublicSession(data) }, 201)
}
