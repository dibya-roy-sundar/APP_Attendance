import { actorOf } from '@/lib/admin'
import { fail, guardPrimary, normaliseDeviceId, ok, readJson } from '@/lib/api'
import { audit, getStudentByDevice, getStudentByRollNo, invalidateStudents } from '@/lib/data'
import { env } from '@/lib/env'
import { db } from '@/lib/supabase'

/**
 * Binds the admin's own phone to their student record, without a scan.
 *
 * Exists because an admin with only one device cannot scan a QR code that their
 * own screen is displaying. Skipping the QR is sound here: the token proves
 * somebody is in the room looking at the projector, whereas the admin cookie is
 * a strictly stronger claim — and `ADMIN_ROLL_NO` decides which student is
 * being claimed, not anything the client sends. It also works while the
 * registration window is closed, for the same reason.
 *
 * Primary only. A deputy must never bind a device to the admin's identity.
 */
export async function POST(req: Request) {
  const guard = await guardPrimary()
  if (!guard.ok) return guard.response

  const deviceId = normaliseDeviceId((await readJson(req)).deviceId)
  if (!deviceId) return fail('BAD_DEVICE')

  const rollNo = env.adminRollNo
  if (!rollNo) return fail('NO_ADMIN_ROLL', 409)

  const student = await getStudentByRollNo(rollNo)
  if (!student) return fail('UNKNOWN_ROLL', 404)

  // Already this phone: report success so the button is safe to tap twice.
  if (student.device_id === deviceId) {
    return ok({ status: 'ALREADY_LINKED', name: student.name, rollNo: student.roll_no })
  }

  // This phone belongs to a different student — refuse rather than steal it.
  const holder = await getStudentByDevice(deviceId)
  if (holder && holder.id !== student.id) {
    return fail('DEVICE_ALREADY_BOUND', 409, { name: holder.name })
  }

  const { data, error } = await db()
    .from('students')
    .update({
      device_id: deviceId,
      enrolled_at: new Date().toISOString(),
    })
    .eq('id', student.id)
    .select('id, name, roll_no')
    .single()
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      return fail('DEVICE_ALREADY_BOUND', 409)
    }
    throw error
  }

  invalidateStudents()
  await audit({
    action: 'CLAIM_DEVICE',
    studentId: data.id,
    actor: actorOf(guard.principal),
    reason: `admin linked own phone to ${data.roll_no}`,
  })
  return ok({ status: 'LINKED', name: data.name, rollNo: data.roll_no })
}
