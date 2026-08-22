import { actorOf, generateCode, hashCode } from '@/lib/admin'
import { fail, guardPrimary, isUuid, ok, readJson } from '@/lib/api'
import { audit, listStudents } from '@/lib/data'
import { db } from '@/lib/supabase'

const MIN_HOURS = 1
const MAX_HOURS = 24 * 7
const MAX_LABEL = 80

/** Active and recent grants. Codes are never returned — only their hashes exist. */
export async function GET() {
  const guard = await guardPrimary()
  if (!guard.ok) return guard.response

  const { data, error } = await db()
    .from('admin_grants')
    .select('id, label, expires_at, revoked_at, last_used_at, created_at')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw error

  const now = Date.now()
  return ok({
    grants: (data ?? []).map((g) => ({
      id: g.id,
      label: g.label,
      expiresAt: g.expires_at,
      revokedAt: g.revoked_at,
      lastUsedAt: g.last_used_at,
      createdAt: g.created_at,
      active: g.revoked_at === null && new Date(g.expires_at).getTime() > now,
    })),
  })
}

/**
 * Issues temporary access. The code is returned **once** and only its hash is
 * stored, so a lost code has to be reissued rather than looked up.
 *
 * A deputy can run a class — sessions, the QR, marking attendance — and export a
 * view-only copy. They cannot reset devices or hand
 * out further access.
 */
export async function POST(req: Request) {
  const guard = await guardPrimary()
  if (!guard.ok) return guard.response

  const body = await readJson(req)
  const hours = body.hours ?? 8

  /*
   * Access is granted to somebody already on the roster, chosen by id — the
   * label is then derived here rather than accepted from the client, so a
   * request cannot invent a person who does not exist or mislabel a real one.
   * The name is what gets stamped on their view-only export, so it has to be
   * trustworthy.
   */
  if (!isUuid(body.studentId)) return fail('MISSING_STUDENT')
  const student = (await listStudents()).find((s) => s.id === body.studentId)
  if (!student) return fail('UNKNOWN_STUDENT', 404)
  const label = `${student.name.trim()} (${student.roll_no})`.slice(0, MAX_LABEL)
  if (
    typeof hours !== 'number' ||
    !Number.isFinite(hours) ||
    hours < MIN_HOURS ||
    hours > MAX_HOURS
  ) {
    return fail('BAD_HOURS')
  }

  const code = generateCode()
  const expiresAt = new Date(Date.now() + hours * 3_600_000)

  const { data, error } = await db()
    .from('admin_grants')
    .insert({ label, code_hash: hashCode(code), expires_at: expiresAt.toISOString() })
    .select('id, label, expires_at')
    .single()
  if (error) throw error

  await audit({
    action: 'GRANT_ISSUED',
    actor: actorOf(guard.principal),
    reason: `${label}, ${hours}h`,
  })

  return ok(
    {
      grant: { id: data.id, label: data.label, expiresAt: data.expires_at },
      // Shown once. Not recoverable afterwards.
      code,
    },
    201
  )
}
