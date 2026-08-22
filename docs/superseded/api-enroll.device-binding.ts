import { fail, normaliseDeviceId, ok, readJson } from '@/lib/api'
import {
  MAX_ROLL_LENGTH,
  getSessionById,
  getStudentByDevice,
  getStudentByRollNo,
} from '@/lib/data'
import { db } from '@/lib/supabase'
import { verifyToken } from '@/lib/token'
import { readDeviceCookie, setDeviceCookie } from '@/lib/device-cookie'
import { isSecureRequest } from '@/lib/admin'

/**
 * Claims a roll number for this device. Enrollment is in-class only: the same
 * live-token check as /api/mark applies, so nobody enrolls from their room.
 */
/**
 * Re-point a student's binding at the id their browser is now carrying.
 *
 * When the cookie is what identified them, localStorage has already minted a
 * fresh uuid and stored it. Leaving the database on the old id would make the
 * cookie the only thing keeping them recognised — lose it and they are stuck
 * asking for a reset. Adopting the browser's new id puts all three copies back
 * in agreement, so either store alone is enough again.
 *
 * Whoever holds the cookie is already treated as this student, so allowing them
 * to re-point it grants nothing new.
 */
async function rebind(studentId: string, deviceId: string): Promise<void> {
  const { error } = await db().from('students').update({ device_id: deviceId }).eq('id', studentId)
  // A rebind is a convenience, not the point of the request: if it collides
  // with another phone's id, the scan should still succeed on the old binding.
  if (error && (error as { code?: string }).code !== '23505') throw error
}

export async function POST(req: Request) {
  const body = await readJson(req)
  const { s, t } = body as { s?: string; t?: string }
  const deviceId = normaliseDeviceId(body.deviceId)
  const rollNo = typeof body.rollNo === 'string' ? body.rollNo.trim() : ''

  if (typeof s !== 'string' || !s) return fail('MISSING_SESSION')
  const cookieId = readDeviceCookie(req)
  if (!deviceId && !cookieId) return fail('BAD_DEVICE')
  if (!rollNo || rollNo.length > MAX_ROLL_LENGTH) return fail('UNKNOWN_ROLL')

  const session = await getSessionById(s)
  if (!session) return fail('SESSION_CLOSED', 409)
  if (!session.is_open || new Date(session.expires_at).getTime() <= Date.now()) {
    return fail('SESSION_CLOSED', 409)
  }
  if (!verifyToken(session.secret, session.id, t as string, Date.now(), session.window_seconds)) {
    return fail('BAD_TOKEN', 409)
  }

  // If this device is already bound, enrolling is a no-op — just mark them.
  // The cookie is consulted too: a phone whose localStorage Safari purged is
  // still this student, and must not be sent down the claim path below to be
  // told their own roll number belongs to someone else.
  let existing = deviceId ? await getStudentByDevice(deviceId) : null
  let boundId = deviceId
  if (!existing && cookieId && cookieId !== deviceId) {
    existing = await getStudentByDevice(cookieId)
    boundId = cookieId
  }
  if (existing) {
    if (existing.roll_no.toLowerCase() !== rollNo.toLowerCase()) {
      return fail('DEVICE_ALREADY_BOUND', 409, { name: existing.name })
    }
    if (deviceId && boundId !== deviceId) {
      await rebind(existing.id, deviceId)
      boundId = deviceId
    }
    await markPresent(session.id, existing.id, boundId as string)
    return setDeviceCookie(
      ok({ status: 'MARKED', name: existing.name, rollNo: existing.roll_no }),
      boundId as string,
      isSecureRequest(req)
    )
  }
  if (!deviceId) return fail('BAD_DEVICE')

  const student = await getStudentByRollNo(rollNo)
  if (!student) return fail('UNKNOWN_ROLL', 404)
  if (student.device_id !== null) return fail('ALREADY_CLAIMED', 409)

  /*
   * There is no registration window any more.
   *
   * It only ever defended against somebody claiming an *unclaimed* roll number
   * unilaterally, and that case is recoverable: the real student is told the
   * number is taken, and the admin resets it. It gave no protection at all
   * against the case that actually has a motive — a student registering
   * normally and handing their id to a friend — because that needs no window.
   * So the toggle, the timer and the banner were machinery guarding a narrow,
   * self-correcting case, and are gone.
   */
  // Guarded update: `is('device_id', null)` means two phones racing for the same
  // roll number cannot both win, without needing a transaction.
  const { data: claimed, error: claimError } = await db()
    .from('students')
    .update({
      device_id: deviceId,
      enrolled_at: new Date().toISOString(),
    })
    .eq('id', student.id)
    .is('device_id', null)
    .select('id, name, roll_no')
  if (claimError) {
    // Unique violation on device_id: this phone claimed someone else mid-request.
    if ((claimError as { code?: string }).code === '23505') {
      return fail('DEVICE_ALREADY_BOUND', 409)
    }
    throw claimError
  }
  if (!claimed || claimed.length === 0) return fail('ALREADY_CLAIMED', 409)

  await markPresent(session.id, claimed[0].id, deviceId)
  return setDeviceCookie(
    ok({
      status: 'ENROLLED',
      name: claimed[0].name,
      rollNo: claimed[0].roll_no,
      classDate: session.class_date,
    }),
    deviceId,
    isSecureRequest(req)
  )
}

async function markPresent(sessionId: string, studentId: string, deviceId: string) {
  const { error } = await db()
    .from('attendance')
    .upsert(
      { session_id: sessionId, student_id: studentId, device_id: deviceId, source: 'scan' },
      { onConflict: 'session_id,student_id', ignoreDuplicates: true }
    )
  if (error) throw error
}
