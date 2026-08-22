import { actorOf } from '@/lib/admin'
import { fail, guardAdmin } from '@/lib/api'
import { audit, listSessions, listStudents } from '@/lib/data'
import { isValidDateString } from '@/lib/dates'
import { buildWorkbook, exportFilename } from '@/lib/export'
import { db } from '@/lib/supabase'
import type { NextRequest } from 'next/server'

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * Generated from Postgres on every request. Nothing writes to a file at runtime.
 *
 * `from` and `to` narrow which class dates become columns; omitting both gives
 * the whole term, which is the copy that matches the instructor's own sheet.
 * A deputy's copy comes out view-only and stamped with their name.
 */
export async function GET(req: NextRequest) {
  const guard = await guardAdmin()
  if (!guard.ok) return guard.response

  const from = req.nextUrl.searchParams.get('from')
  const to = req.nextUrl.searchParams.get('to')
  if (from !== null && !isValidDateString(from)) return fail('BAD_DATE')
  if (to !== null && !isValidDateString(to)) return fail('BAD_DATE')
  if (from && to && from > to) return fail('BAD_RANGE')

  const [students, allSessions, marks] = await Promise.all([
    listStudents(),
    listSessions(),
    db().from('attendance').select('session_id, student_id'),
  ])
  if (marks.error) throw marks.error

  const sessions = allSessions.filter(
    (s) => (!from || s.class_date >= from) && (!to || s.class_date <= to)
  )
  const inRange = new Set(sessions.map((s) => s.id))

  const sNoById = new Map(students.map((s) => [s.id, s.s_no]))
  const present = new Map<number, Set<string>>()
  for (const mark of marks.data ?? []) {
    if (!inRange.has(mark.session_id)) continue
    const sNo = sNoById.get(mark.student_id)
    if (sNo === undefined) continue
    let set = present.get(sNo)
    if (!set) present.set(sNo, (set = new Set()))
    set.add(mark.session_id)
  }

  const deputy = guard.principal.kind === 'deputy' ? guard.principal : null
  const buffer = await buildWorkbook(
    students,
    sessions,
    present,
    deputy
      ? { issuedTo: deputy.label, issuedAt: new Date(), range: { from: from ?? undefined, to: to ?? undefined } }
      : undefined
  )

  const label = [
    'soft-skills-attendance',
    from || to ? `${from ?? 'start'}_${to ?? 'today'}` : null,
    deputy ? 'view-only' : null,
  ]
    .filter(Boolean)
    .join('-')

  // The server-side record of who exported what; the admin page also keeps a
  // local list, but this is the one that cannot be cleared from a browser.
  await audit({
    action: 'EXPORT',
    actor: actorOf(guard.principal),
    reason: `${sessions.length} ${sessions.length === 1 ? 'class' : 'classes'}, ${
      from || to ? `${from ?? 'start'}..${to ?? 'today'}` : 'whole term'
    }${deputy ? ', view-only' : ''}`,
  })

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': XLSX_TYPE,
      'Content-Disposition': `attachment; filename="${exportFilename(label)}"`,
      'Cache-Control': 'no-store',
      // Lets the admin page record the download without re-parsing the file.
      'X-Export-Classes': String(sessions.length),
      'X-Export-View-Only': deputy ? '1' : '0',
    },
  })
}

export const dynamic = 'force-dynamic'
