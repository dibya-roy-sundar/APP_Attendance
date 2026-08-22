import { actorOf } from '@/lib/admin'
import { fail, guardPrimary, ok, readJson } from '@/lib/api'
import {
  DEFAULT_ENROLLMENT_MINUTES,
  audit,
  getEnrollmentState,
  isValidEnrollmentMinutes,
  setEnrollmentOpen,
} from '@/lib/data'

export async function GET() {
  const guard = await guardPrimary()
  if (!guard.ok) return guard.response
  const state = await getEnrollmentState()
  return ok({ enrollmentOpen: state.open, enrollmentClosesAt: state.closesAt })
}

/**
 * Opens registration for a fixed number of minutes, or closes it now.
 *
 * A duration is required when opening. Registration is the one window where a
 * public roll number is enough to claim an identity, so the thing most worth
 * preventing is leaving it open because nobody remembered to close it.
 */
export async function POST(req: Request) {
  const guard = await guardPrimary()
  if (!guard.ok) return guard.response

  const body = await readJson(req)
  const { open } = body as { open?: boolean }
  if (typeof open !== 'boolean') return fail('BAD_REQUEST')

  let minutes: number | undefined
  if (open) {
    minutes = body.minutes === undefined ? DEFAULT_ENROLLMENT_MINUTES : (body.minutes as number)
    if (!isValidEnrollmentMinutes(minutes)) return fail('BAD_MINUTES')
  }

  const closesAt = await setEnrollmentOpen(open, minutes)
  await audit({
    action: open ? 'OPEN_ENROLLMENT' : 'CLOSE_ENROLLMENT',
    actor: actorOf(guard.principal),
    reason: open ? `open for ${minutes} min` : 'closed by hand',
  })
  return ok({ enrollmentOpen: open, enrollmentClosesAt: closesAt })
}
