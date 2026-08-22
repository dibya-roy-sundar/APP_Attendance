import { fail, isUuid, ok, readJson, guardAdmin } from '@/lib/api'
import { actorOf } from '@/lib/admin'
import { audit, getSessionById } from '@/lib/data'
import { db } from '@/lib/supabase'

const MAX_REASON = 200

/**
 * One endpoint behind every tap on the grid: no row becomes a manual mark, an
 * existing row is removed. Undo is just tapping again.
 */
export async function POST(req: Request) {
  const guard = await guardAdmin()
  if (!guard.ok) return guard.response

  const body = await readJson(req)
  const { studentId, sessionId } = body as { studentId?: string; sessionId?: string }
  const reason =
    typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim().slice(0, MAX_REASON)
      : null

  if (!isUuid(studentId) || !isUuid(sessionId)) return fail('BAD_REQUEST')

  const session = await getSessionById(sessionId)
  if (!session) return fail('NO_SESSION', 404)

  const { data: student, error: studentError } = await db()
    .from('students')
    .select('id, name')
    .eq('id', studentId)
    .maybeSingle()
  if (studentError) throw studentError
  if (!student) return fail('NO_STUDENT', 404)

  const { data: existing, error: readError } = await db()
    .from('attendance')
    .select('student_id')
    .eq('session_id', sessionId)
    .eq('student_id', studentId)
    .maybeSingle()
  if (readError) throw readError

  if (existing) {
    const { error } = await db()
      .from('attendance')
      .delete()
      .eq('session_id', sessionId)
      .eq('student_id', studentId)
    if (error) throw error
    await audit({
      action: 'OVERRIDE_UNMARK',
      studentId,
      sessionId,
      reason,
      actor: actorOf(guard.principal),
    })
    return ok({ status: 'UNMARKED', studentId, markedAt: null, source: null })
  }

  const markedAt = new Date().toISOString()
  const { error } = await db().from('attendance').insert({
    session_id: sessionId,
    student_id: studentId,
    marked_at: markedAt,
    source: 'manual',
    device_id: null,
  })
  // A scan that landed between our read and this insert is not an error —
  // the student is present either way, which is the state we report back.
  if (error && (error as { code?: string }).code !== '23505') throw error

  await audit({
    action: 'OVERRIDE_MARK',
    studentId,
    sessionId,
    reason,
    actor: actorOf(guard.principal),
  })
  return ok({ status: 'MARKED', studentId, markedAt, source: 'manual' })
}
