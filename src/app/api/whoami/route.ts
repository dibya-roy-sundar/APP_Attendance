import { guardAdmin, ok } from '@/lib/api'

/** Lets the admin page render the right controls for whoever is signed in. */
export async function GET() {
  const guard = await guardAdmin()
  if (!guard.ok) return guard.response
  const p = guard.principal
  return ok(
    p.kind === 'primary'
      ? { role: 'primary' as const }
      : { role: 'deputy' as const, label: p.label, expiresAt: p.expiresAt }
  )
}

export const dynamic = 'force-dynamic'
