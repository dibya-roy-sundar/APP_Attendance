import { actorOf } from '@/lib/admin'
import { fail, guardPrimary, isUuid, ok, readJson } from '@/lib/api'
import { audit, getStudentById } from '@/lib/data'
import { credentialsForStudent } from '@/lib/passkey'
import { db } from '@/lib/supabase'

/**
 * Removes a student's passkeys so they can register a new phone.
 *
 * Not the normal recovery path — that is the approval queue, where a student
 * on a new phone claims their roll number and the admin approves it. This is
 * the blunter instrument, for when a passkey should simply cease to exist: a
 * student who has left, or a credential believed compromised.
 *
 * Kept separate from approval on purpose. Approving says "this specific new
 * device is legitimate"; this says "whatever is registered should not be", and
 * leaves the roll number free for the next first claim.
 *
 * Attendance is untouched. Those rows reference `student_id`, never a
 * credential, so the record of who was present survives any number of phone
 * changes. What is destroyed is the ability to sign in, so what is being
 * destroyed is written into the audit entry first.
 */
export async function POST(req: Request) {
  const guard = await guardPrimary()
  if (!guard.ok) return guard.response

  const body = await readJson(req)
  const { studentId } = body as { studentId?: string }
  const note = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : ''
  if (!isUuid(studentId)) return fail('BAD_REQUEST')

  const student = await getStudentById(studentId)
  if (!student) return fail('NO_STUDENT', 404)

  const existing = await credentialsForStudent(studentId)
  if (existing.length === 0) return fail('NO_PASSKEY', 409)

  const { error } = await db().from('student_credentials').delete().eq('student_id', studentId)
  if (error) throw error


  // Recorded before the fact is lost: which credentials existed, on what, and
  // when they were made. Otherwise fixing the problem erases the evidence of it.
  const held = existing
    .map(
      (c) =>
        `${c.device_label ?? 'unknown device'} (${c.credential_id.slice(0, 12)}…, added ${c.created_at.slice(0, 10)})`
    )
    .join('; ')
  await audit({
    action: 'PASSKEY_REMOVED',
    studentId,
    actor: actorOf(guard.principal),
    reason: note ? `${note} — removed ${existing.length}: ${held}` : `removed ${existing.length}: ${held}`,
  })

  return ok({ status: 'REMOVED', removed: existing.length, name: student.name })
}

export const dynamic = 'force-dynamic'
