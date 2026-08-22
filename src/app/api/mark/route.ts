import { fail, normaliseDeviceId, ok, readJson } from '@/lib/api'
import { getSessionById, getStudentByDevice } from '@/lib/data'
import { db } from '@/lib/supabase'
import { verifyToken } from '@/lib/token'

/**
 * The scan endpoint. Deliberately open (no admin cookie) but gated on a token
 * that dies within 30 seconds, so it can only be called from a phone that is
 * looking at the projected QR right now.
 */
export async function POST(req: Request) {
  const body = await readJson(req)
  const { s, t } = body as { s?: string; t?: string }
  const deviceId = normaliseDeviceId(body.deviceId)

  if (typeof s !== 'string' || !s) return fail('MISSING_SESSION')
  if (!deviceId) return fail('BAD_DEVICE')

  const session = await getSessionById(s)
  if (!session) return fail('SESSION_CLOSED', 409)
  if (!session.is_open || new Date(session.expires_at).getTime() <= Date.now()) {
    return fail('SESSION_CLOSED', 409)
  }
  if (!verifyToken(session.secret, session.id, t as string, Date.now(), session.window_seconds)) {
    return fail('BAD_TOKEN', 409)
  }

  const student = await getStudentByDevice(deviceId)
  if (!student) {
    // Any phone we do not recognise is offered registration; a live token
    // already proves the holder is in the room looking at the projector.
    return ok({ status: 'NEEDS_ENROLL', classDate: session.class_date })
  }

  // The primary key makes a second scan a no-op rather than an error, so a
  // student who taps twice sees the same reassuring tick.
  const { error } = await db()
    .from('attendance')
    .upsert(
      {
        session_id: session.id,
        student_id: student.id,
        device_id: deviceId,
        source: 'scan',
      },
      { onConflict: 'session_id,student_id', ignoreDuplicates: true }
    )
  if (error) throw error

  return ok({
    status: 'MARKED',
    name: student.name,
    rollNo: student.roll_no,
    classDate: session.class_date,
  })
}
