import { fail, normaliseDeviceId, ok, readJson } from '@/lib/api'
import { getSessionById, getStudentByDevice } from '@/lib/data'
import { db } from '@/lib/supabase'
import { verifyToken } from '@/lib/token'
import { readDeviceCookie, setDeviceCookie } from '@/lib/device-cookie'
import { isSecureRequest } from '@/lib/admin'

/**
 * The scan endpoint. Deliberately open (no admin cookie) but gated on a token
 * that dies within 30 seconds, so it can only be called from a phone that is
 * looking at the projected QR right now.
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

  if (typeof s !== 'string' || !s) return fail('MISSING_SESSION')
  // Either store is enough. localStorage is asked first because it is the one
  // the student's own browser owns; the cookie covers the case where Safari has
  // purged script-writable storage since the last class.
  const cookieId = readDeviceCookie(req)
  if (!deviceId && !cookieId) return fail('BAD_DEVICE')

  const session = await getSessionById(s)
  if (!session) return fail('SESSION_CLOSED', 409)
  if (!session.is_open || new Date(session.expires_at).getTime() <= Date.now()) {
    return fail('SESSION_CLOSED', 409)
  }
  if (!verifyToken(session.secret, session.id, t as string, Date.now(), session.window_seconds)) {
    return fail('BAD_TOKEN', 409)
  }

  let student = deviceId ? await getStudentByDevice(deviceId) : null
  let boundId = deviceId
  if (!student && cookieId && cookieId !== deviceId) {
    student = await getStudentByDevice(cookieId)
    boundId = cookieId
  }
  if (!student) {
    // Any phone we do not recognise is offered registration; a live token
    // already proves the holder is in the room looking at the projector.
    return ok({ status: 'NEEDS_ENROLL', classDate: session.class_date })
  }

  // Recognised by cookie while the browser carries a different id: adopt theirs
  // so localStorage and the cookie are redundant again rather than the cookie
  // being a single point of failure.
  if (deviceId && boundId !== deviceId) {
    await rebind(student.id, deviceId)
    boundId = deviceId
  }

  // The primary key makes a second scan a no-op rather than an error, so a
  // student who taps twice sees the same reassuring tick.
  const { error } = await db()
    .from('attendance')
    .upsert(
      {
        session_id: session.id,
        student_id: student.id,
        device_id: boundId,
        source: 'scan',
      },
      { onConflict: 'session_id,student_id', ignoreDuplicates: true }
    )
  if (error) throw error

  // Re-write the cookie on every recognised scan so it never quietly lapses,
  // and so a phone that still has localStorage regains the durable copy.
  return setDeviceCookie(
    ok({
      status: 'MARKED',
      name: student.name,
      rollNo: student.roll_no,
      classDate: session.class_date,
    }),
    boundId as string,
    isSecureRequest(req)
  )
}
