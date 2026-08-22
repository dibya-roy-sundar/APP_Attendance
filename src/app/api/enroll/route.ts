import { fail, normaliseDeviceId, ok, readJson } from '@/lib/api'
import {
  MAX_ROLL_LENGTH,
  getSessionById,
  getStudentByDevice,
  getStudentByRollNo,
} from '@/lib/data'
import { db } from '@/lib/supabase'
import { verifyToken } from '@/lib/token'

/**
 * Claims a roll number for this device. Enrollment is in-class only: the same
 * live-token check as /api/mark applies, so nobody enrolls from their room.
 */
export async function POST(req: Request) {
  const body = await readJson(req)
  const { s, t } = body as { s?: string; t?: string }
  const deviceId = normaliseDeviceId(body.deviceId)
  const rollNo = typeof body.rollNo === 'string' ? body.rollNo.trim() : ''

  if (typeof s !== 'string' || !s) return fail('MISSING_SESSION')
  if (!deviceId) return fail('BAD_DEVICE')
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
  const existing = await getStudentByDevice(deviceId)
  if (existing) {
    if (existing.roll_no.toLowerCase() !== rollNo.toLowerCase()) {
      return fail('DEVICE_ALREADY_BOUND', 409, { name: existing.name })
    }
    await markPresent(session.id, existing.id, deviceId)
    return ok({ status: 'MARKED', name: existing.name, rollNo: existing.roll_no })
  }

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
      reset_allowed: false,
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
  return ok({
    status: 'ENROLLED',
    name: claimed[0].name,
    rollNo: claimed[0].roll_no,
    classDate: session.class_date,
  })
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
