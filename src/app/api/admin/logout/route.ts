import { ADMIN_COOKIE } from '@/lib/admin'
import { ok } from '@/lib/api'
import { cookies } from 'next/headers'

export async function POST() {
  ;(await cookies()).delete(ADMIN_COOKIE)
  return ok({ status: 'OK' })
}
