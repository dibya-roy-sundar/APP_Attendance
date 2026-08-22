import { actorOf } from '@/lib/admin'
import { fail, guardAdmin, isUuid, ok, readJson } from '@/lib/api'
import { audit, getSessionById } from '@/lib/data'
import { db } from '@/lib/supabase'

const MAX_REASON = 200

/**
 * Removes one mark. Deliberate and immediate — it is rare, and the grid does not
 * let a stray tap reach it, so there is nothing to batch.
 *
 * Idempotent: deleting a mark that is not there succeeds. Two taps arriving
 * together cannot disagree about the outcome, which is what went wrong with the
 * old toggle.
 */
export async function POST(req: Request) {
  const guard = await guardAdmin()
  if (!guard.ok) return guard.response

  const body = await readJson(req)
  const { sessionId, studentId } = body as { sessionId?: string; studentId?: string }
  const reason =
    typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim().slice(0, MAX_REASON)
      : null

  if (!isUuid(sessionId) || !isUuid(studentId)) return fail('BAD_REQUEST')

  const session = await getSessionById(sessionId)
  if (!session) return fail('NO_SESSION', 404)

  const { data, error } = await db()
    .from('attendance')
    .delete()
    .eq('session_id', sessionId)
    .eq('student_id', studentId)
    .select('student_id')
  if (error) throw error

  const removed = (data ?? []).length > 0
  if (removed) {
    await audit({
      action: 'OVERRIDE_UNMARK',
      studentId,
      sessionId,
      reason,
      actor: actorOf(guard.principal),
    })
  }
  return ok({ status: removed ? 'UNMARKED' : 'ALREADY_ABSENT', studentId })
}
