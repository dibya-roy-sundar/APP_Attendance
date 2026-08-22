import { fail, isUuid, ok, readJson, guardAdmin } from '@/lib/api'
import { db } from '@/lib/supabase'

const MAX_REASON = 200

/**
 * Attaches a reason to the toggle that just happened.
 *
 * The tap writes its audit entry immediately with no reason, because a mandatory
 * reason field gets filled with junk by day three. The chips are an afterthought
 * offered for a few seconds, so they annotate that entry rather than re-toggling
 * the row — the attendance state must not move when a chip is tapped.
 */
export async function POST(req: Request) {
  const guard = await guardAdmin()
  if (!guard.ok) return guard.response

  const body = await readJson(req)
  const { studentId, sessionId } = body as { studentId?: string; sessionId?: string }
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, MAX_REASON) : ''
  if (!isUuid(studentId) || !isUuid(sessionId) || !reason) return fail('BAD_REQUEST')

  const { data: latest, error: readError } = await db()
    .from('audit_log')
    .select('id, action')
    .eq('student_id', studentId)
    .eq('session_id', sessionId)
    .in('action', ['OVERRIDE_MARK', 'OVERRIDE_UNMARK'])
    .order('id', { ascending: false })
    .limit(1)
  if (readError) throw readError
  if (!latest?.length) return fail('NOTHING_TO_ANNOTATE', 404)

  const { error } = await db()
    .from('audit_log')
    .update({ reason })
    .eq('id', latest[0].id)
  if (error) throw error

  return ok({ status: 'ANNOTATED', action: latest[0].action, reason })
}
