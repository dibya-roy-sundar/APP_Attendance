import { fail, ok, readJson, guardPrimary } from '@/lib/api'
import { actorOf } from '@/lib/admin'
import { audit, isEnrollmentOpen, setEnrollmentOpen } from '@/lib/data'

export async function GET() {
  const guard = await guardPrimary()
  if (!guard.ok) return guard.response
  return ok({ enrollmentOpen: await isEnrollmentOpen() })
}

export async function POST(req: Request) {
  const guard = await guardPrimary()
  if (!guard.ok) return guard.response

  const { open } = await readJson(req)
  if (typeof open !== 'boolean') return fail('BAD_REQUEST')

  await setEnrollmentOpen(open)
  await audit({
    action: open ? 'OPEN_ENROLLMENT' : 'CLOSE_ENROLLMENT',
    actor: actorOf(guard.principal),
  })
  return ok({ enrollmentOpen: open })
}
