import { fail, normaliseDeviceId, ok, readJson } from '@/lib/api'
import { getStudentByDevice, listSessions } from '@/lib/data'
import { db } from '@/lib/supabase'

/**
 * A student's own record, and only their own. POST rather than GET so the device
 * id stays out of URLs, referrers and access logs.
 */
export async function POST(req: Request) {
  const deviceId = normaliseDeviceId((await readJson(req)).deviceId)
  if (!deviceId) return fail('NOT_REGISTERED', 404)

  const student = await getStudentByDevice(deviceId)
  if (!student) return fail('NOT_REGISTERED', 404)

  const [sessions, marks] = await Promise.all([
    listSessions(),
    db().from('attendance').select('session_id, marked_at').eq('student_id', student.id),
  ])
  if (marks.error) throw marks.error

  const markedAt = new Map(marks.data?.map((m) => [m.session_id, m.marked_at]) ?? [])
  const days = sessions
    .map((s) => ({
      classDate: s.class_date,
      present: markedAt.has(s.id),
      markedAt: markedAt.get(s.id) ?? null,
    }))
    .reverse() // most recent first

  const present = days.filter((d) => d.present).length
  return ok({
    name: student.name,
    rollNo: student.roll_no,
    present,
    total: days.length,
    percent: days.length ? (present / days.length) * 100 : null,
    days,
  })
}
