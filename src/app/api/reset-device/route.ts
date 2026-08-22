import { actorOf } from '@/lib/admin'
import { fail, guardPrimary, isUuid, ok, readJson } from '@/lib/api'
import { audit, invalidateStudents } from '@/lib/data'
import { db } from '@/lib/supabase'

/**
 * Unbinds a student's phone so they can register a new one.
 *
 * For a lost or wiped handset — and for the case where somebody else claimed
 * their roll number first.
 *
 * Attendance is untouched: the rows reference `student_id`, and each carries its
 * own `device_id` snapshot, so the history of who was marked present survives a
 * reset intact. What the reset does erase from `students` is the binding itself,
 * so that is written into the audit entry first. Otherwise the act of fixing the
 * problem destroys the only record of what the problem was.
 */
export async function POST(req: Request) {
  const guard = await guardPrimary()
  if (!guard.ok) return guard.response

  const body = await readJson(req)
  const { studentId } = body as { studentId?: string }
  const note = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : ''
  if (!isUuid(studentId)) return fail('BAD_REQUEST')

  // Read the binding before clearing it, so it can be recorded.
  const { data: before, error: readError } = await db()
    .from('students')
    .select('id, name, roll_no, device_id, enrolled_at')
    .eq('id', studentId)
    .maybeSingle()
  if (readError) throw readError
  if (!before) return fail('NO_STUDENT', 404)

  const { data, error } = await db()
    .from('students')
    .update({ device_id: null, reset_allowed: true, enrolled_at: null })
    .eq('id', studentId)
    .select('id, name, roll_no')
    .maybeSingle()
  if (error) throw error
  if (!data) return fail('NO_STUDENT', 404)

  invalidateStudents()

  const held = before.device_id
    ? `was device ${before.device_id}, registered ${before.enrolled_at ?? 'unknown'}`
    : 'had no phone registered'
  await audit({
    action: 'RESET_DEVICE',
    studentId,
    actor: actorOf(guard.principal),
    reason: note ? `${note} — ${held}` : held,
  })

  return ok({
    status: 'RESET',
    name: data.name,
    rollNo: data.roll_no,
    previousDeviceId: before.device_id,
    previouslyRegisteredAt: before.enrolled_at,
  })
}
