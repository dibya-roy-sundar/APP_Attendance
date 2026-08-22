import { fail } from '@/lib/api'
import { readStudentSession } from '@/lib/student-session'
import { getStudentById, listSessions } from '@/lib/data'
import { buildWorkbook, exportFilename } from '@/lib/export'
import { db } from '@/lib/supabase'

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** The same sheet layout, containing exactly one student: the caller's own row. */
export async function POST(req: Request) {
  // Identity comes from the passkey session, established the last time this
  // student confirmed with Face ID or a fingerprint. Reading a record is not
  // marking attendance, so a session is enough here — /api/passkey/auth/verify
  // is the only thing that can record presence, and it always demands a fresh
  // assertion plus a live token.
  const studentId = readStudentSession(req)
  if (!studentId) return fail('NOT_REGISTERED', 404)

  const student = await getStudentById(studentId)
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
