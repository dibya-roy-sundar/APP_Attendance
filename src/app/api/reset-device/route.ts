import { fail, isUuid, ok, readJson, guardPrimary } from '@/lib/api'
import { actorOf } from '@/lib/admin'
import { audit, invalidateStudents } from '@/lib/data'
import { db } from '@/lib/supabase'

/**
 * For a lost or wiped phone. Clears the binding and grants that one student a
 * fresh claim, even while the enrollment window is closed.
 */
export async function POST(req: Request) {
  const guard = await guardPrimary()
  if (!guard.ok) return guard.response

  const body = await readJson(req)
  const { studentId } = body as { studentId?: string }
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : null
  if (!isUuid(studentId)) return fail('BAD_REQUEST')

  const { data, error } = await db()
    .from('students')
    .update({ device_id: null, reset_allowed: true, enrolled_at: null })
    .eq('id', studentId)
    .select('id, name, roll_no')
    .maybeSingle()
  if (error) throw error
  if (!data) return fail('NO_STUDENT', 404)

  invalidateStudents()
  await audit({
    action: 'RESET_DEVICE',
    studentId,
    reason,
    actor: actorOf(guard.principal),
  })
  return ok({ status: 'RESET', name: data.name, rollNo: data.roll_no })
}
