import { isAdmin } from '@/lib/admin'
import { AdminClient } from './AdminClient'
import { LoginForm } from './LoginForm'

/**
 * Gate is server-side. The grid never renders for a caller without a valid
 * signed cookie, and every endpoint behind it re-checks independently.
 */
export default async function AdminPage() {
  if (!(await isAdmin())) return <LoginForm />
  return <AdminClient />
}

export const dynamic = 'force-dynamic'
