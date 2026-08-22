import { fail, ok, guardAdmin } from '@/lib/api'
import {
  getDefaultSession,
  getRoster,
  getSessionById,
  isEnrollmentOpen,
  listSessions,
  toPublicSession,
} from '@/lib/data'
import { classDate } from '@/lib/dates'
import type { NextRequest } from 'next/server'

/**
 * Everything the grid needs in one poll: the session, all 47 students with their
 * marks, the enrollment flag, and the date list for the picker.
 */
export async function GET(req: NextRequest) {
  const guard = await guardAdmin()
  if (!guard.ok) return guard.response

  const sessionId = req.nextUrl.searchParams.get('s')
  const session = sessionId ? await getSessionById(sessionId) : await getDefaultSession()
  if (sessionId && !session) return fail('NO_SESSION', 404)

  const [students, enrollmentOpen, sessions] = await Promise.all([
    getRoster(session?.id ?? null, guard.principal.kind === 'primary'),
    isEnrollmentOpen(),
    listSessions(),
  ])

  return ok({
    role: guard.principal.kind,
    deputyLabel: guard.principal.kind === 'deputy' ? guard.principal.label : null,
    deputyExpiresAt: guard.principal.kind === 'deputy' ? guard.principal.expiresAt : null,
    session: session ? toPublicSession(session) : null,
    students,
    markedCount: students.filter((s) => s.markedAt).length,
    total: students.length,
    enrollmentOpen,
    sessions: sessions.map((s) => ({
      id: s.id,
      classDate: s.class_date,
      isOpen: s.is_open,
    })),
    today: classDate(),
    serverTime: new Date().toISOString(),
  })
}

export const dynamic = 'force-dynamic'
