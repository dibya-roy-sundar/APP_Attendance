import { fail, normaliseDeviceId, readJson } from '@/lib/api'
import { readDeviceCookie } from '@/lib/device-cookie'
import { getStudentByDevice, listSessions } from '@/lib/data'
import { buildWorkbook, exportFilename } from '@/lib/export'
import { db } from '@/lib/supabase'

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** The same sheet layout, containing exactly one student: the caller's own row. */
export async function POST(req: Request) {
  const deviceId = normaliseDeviceId((await readJson(req)).deviceId)
  // The httpOnly cookie is the durable copy: Safari purges script-writable
  // storage after about a week idle, so localStorage may be gone while the
  // student is still perfectly well bound.
  const cookieId = readDeviceCookie(req)
  if (!deviceId && !cookieId) return fail('NOT_REGISTERED', 404)

  let student = deviceId ? await getStudentByDevice(deviceId) : null
  if (!student && cookieId && cookieId !== deviceId) {
    student = await getStudentByDevice(cookieId)
  }
  if (!student) return fail('NOT_REGISTERED', 404)

  const [sessions, marks] = await Promise.all([
    listSessions(),
    db().from('attendance').select('session_id').eq('student_id', student.id),
  ])
  if (marks.error) throw marks.error

  const present = new Map([
    [student.s_no, new Set((marks.data ?? []).map((m) => m.session_id))],
  ])
  const buffer = await buildWorkbook([student], sessions, present)

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': XLSX_TYPE,
      'Content-Disposition': `attachment; filename="${exportFilename(
        `attendance-${student.roll_no}`
      )}"`,
      'Cache-Control': 'no-store',
    },
  })
}
