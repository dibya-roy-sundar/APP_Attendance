import { actorOf } from '@/lib/admin'
import { fail, guardPrimary, ok, readJson } from '@/lib/api'
import {
  MAX_ROLL_LENGTH,
  audit,
  getStudentByRollNo,
  invalidateStudents,
  nextStudentNumber,
} from '@/lib/data'
import { db } from '@/lib/supabase'

const MAX_NAME = 120
const MAX_EMAIL = 160

/**
 * Adds a student to the roster.
 *
 * The instructor's own operation: a deputy covering one class has no business
 * changing who is on the register.
 *
 * The new student takes the next `s_no`, so they land at the end of the list and
 * of the exported sheet rather than shifting everybody else's row. Their
 * attendance for classes already held stays blank, which is the truth.
 */
export async function POST(req: Request) {
  const guard = await guardPrimary()
  if (!guard.ok) return guard.response

  const body = await readJson(req)
  const rollNo = typeof body.rollNo === 'string' ? body.rollNo.trim() : ''
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const emailRaw = typeof body.email === 'string' ? body.email.trim() : ''

  if (!name || name.length > MAX_NAME) return fail('BAD_NAME')
  if (!rollNo || rollNo.length > MAX_ROLL_LENGTH) return fail('BAD_ROLL')
  // Roll numbers are matched exactly elsewhere, so keep them to plain
  // identifier characters rather than accepting anything at all.
  if (!/^[A-Za-z0-9._/-]+$/.test(rollNo)) return fail('BAD_ROLL')
  if (emailRaw && (emailRaw.length > MAX_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw))) {
    return fail('BAD_EMAIL')
  }

  // Checked here for a clear message; the unique index is what guarantees it.
  if (await getStudentByRollNo(rollNo)) return fail('ROLL_TAKEN', 409)

  const { data, error } = await db()
    .from('students')
    .insert({
      s_no: await nextStudentNumber(),
      roll_no: rollNo,
      name,
      email: emailRaw || null,
      device_id: null,
      reset_allowed: false,
      enrolled_at: null,
    })
    .select('id, s_no, roll_no, name, email')
    .single()
  if (error) {
    // Two admins adding at once: either the roll number or the position clashed.
    if ((error as { code?: string }).code === '23505') {
      invalidateStudents()
      return fail('ROLL_TAKEN', 409)
    }
    throw error
  }

  invalidateStudents()
  await audit({
    action: 'ADD_STUDENT',
    studentId: data.id,
    actor: actorOf(guard.principal),
    reason: `${data.roll_no} added as S.No ${data.s_no}`,
  })

  return ok(
    {
      status: 'ADDED',
      student: {
        studentId: data.id,
        sNo: data.s_no,
        rollNo: data.roll_no,
        name: data.name,
        email: data.email,
      },
    },
    201
  )
}
