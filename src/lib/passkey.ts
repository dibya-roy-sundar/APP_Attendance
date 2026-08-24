import { canonicalOrigin } from '@/lib/origin'
import { db } from '@/lib/supabase'
import { listStudents } from '@/lib/data'

/**
 * Passkeys are the app's identity. See README for why this replaced the
 * localStorage UUID and the httpOnly cookie before it, and why neither
 * Microsoft sign-in nor an emailed OTP was the answer.
 *
 * Two invariants carry all of the security:
 *
 *  1. The challenge is issued here, stored here, and destroyed on first use. A
 *     challenge the caller chose, or one already spent, must never verify.
 *  2. The expected origin and RP ID come from the server's own configuration,
 *     never from the request. Otherwise a lookalike host could relay an
 *     assertion it obtained elsewhere.
 */

const CHALLENGE_TTL_MS = 5 * 60_000

/** The Relying Party ID is the registrable domain, and passkeys are bound to it. */
export function rpID(req: Request): string {
  return new URL(canonicalOrigin(req) || new URL(req.url).origin).hostname
}

export function expectedOrigin(req: Request): string {
  return canonicalOrigin(req) || new URL(req.url).origin
}

export const RP_NAME = 'Soft Skills Attendance'

/* ── challenges ─────────────────────────────────────────────────────────── */

export async function storeChallenge(
  challenge: string,
  purpose: 'register' | 'authenticate',
  studentId: string | null
): Promise<void> {
  const { error } = await db()
    .from('webauthn_challenges')
    .insert({
      challenge,
      purpose,
      student_id: studentId,
      expires_at: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    })
  if (error) throw error
}

/**
 * Reads a challenge and deletes it in the same breath, so a replay finds
 * nothing. The delete is the gate: if it removed no row, someone else consumed
 * the challenge first and this attempt must fail.
 */
export async function consumeChallenge(
  challenge: string,
  purpose: 'register' | 'authenticate'
): Promise<{ studentId: string | null } | null> {
  const { data, error } = await db()
    .from('webauthn_challenges')
    .delete()
    .eq('challenge', challenge)
    .eq('purpose', purpose)
    .gte('expires_at', new Date().toISOString())
    .select('student_id')
  if (error) throw error
  if (!data || data.length === 0) return null
  return { studentId: data[0].student_id }
}

/** Housekeeping: lapsed challenges are useless, and there is no cron here. */
export async function pruneChallenges(): Promise<void> {
  await db().from('webauthn_challenges').delete().lt('expires_at', new Date().toISOString())
}

/* ── credentials ────────────────────────────────────────────────────────── */

export type CredentialRow = {
  id: string
  student_id: string
  credential_id: string
  public_key: string
  counter: number
  transports: string[] | null
  device_label: string | null
  created_at: string
  last_used_at: string | null
}

export async function credentialById(credentialId: string): Promise<CredentialRow | null> {
  const { data, error } = await db()
    .from('student_credentials')
    .select('*')
    .eq('credential_id', credentialId)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function credentialsForStudent(studentId: string): Promise<CredentialRow[]> {
  const { data, error } = await db()
    .from('student_credentials')
    .select('*')
    .eq('student_id', studentId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

export async function saveCredential(row: {
  studentId: string
  credentialId: string
  publicKey: string
  counter: number
  transports: string[] | null
  deviceLabel: string | null
}): Promise<{ conflict: boolean }> {
  const { error } = await db().from('student_credentials').insert({
    student_id: row.studentId,
    credential_id: row.credentialId,
    public_key: row.publicKey,
    counter: row.counter,
    transports: row.transports,
    device_label: row.deviceLabel,
  })
  // 23505: this credential is already registered, to this student or another.
  if (error && (error as { code?: string }).code === '23505') return { conflict: true }
  if (error) throw error
  return { conflict: false }
}

/**
 * The counter must advance. Authenticators that always report 0 are permitted —
 * many platform authenticators do — but a counter that goes backwards means the
 * assertion was replayed or the credential cloned.
 */
export function counterIsSane(stored: number, presented: number): boolean {
  if (stored === 0 && presented === 0) return true
  return presented > stored
}

export async function touchCredential(credentialId: string, counter: number): Promise<void> {
  const { error } = await db()
    .from('student_credentials')
    .update({ counter, last_used_at: new Date().toISOString() })
    .eq('credential_id', credentialId)
  if (error) throw error
}

/** Shown to the student so they can tell one registered device from another. */
export function deviceLabelFrom(userAgent: string | null): string | null {
  if (!userAgent) return null
  if (/iPhone/i.test(userAgent)) return 'iPhone'
  if (/iPad/i.test(userAgent)) return 'iPad'
  if (/Android/i.test(userAgent)) return 'Android phone'
  if (/Macintosh/i.test(userAgent)) return 'Mac'
  if (/Windows/i.test(userAgent)) return 'Windows PC'
  return null
}

/* ── the approval queue ─────────────────────────────────────────────────── */

const REQUEST_TTL_MS = 3 * 24 * 60 * 60 * 1000
/** Decided rows are evidence of an attempted proxy, so they outlive the claim. */
const REQUEST_KEEP_MS = 14 * 24 * 60 * 60 * 1000

export type PendingRequest = {
  id: string
  studentId: string
  rollNo: string
  name: string
  deviceLabel: string | null
  requestedAt: string
  expiresAt: string
  /** True when that student already has a mark today — a hint, not a verdict. */
  markedToday: boolean
}

/**
 * Records a claim on a roll number that already has a passkey.
 *
 * The credential arrives fully verified, so approving is a question of trust
 * rather than validity. One pending row per student, so a single roll number
 * cannot flood the queue; a fresh claim replaces the pending one, because the
 * newest phone in the room is the one the student is actually holding.
 */
export async function recordRequest(row: {
  studentId: string
  credentialId: string
  publicKey: string
  counter: number
  transports: string[] | null
  deviceLabel: string | null
  sessionId: string | null
  caller: string | null
}): Promise<void> {
  await db()
    .from('passkey_requests')
    .delete()
    .eq('student_id', row.studentId)
    .is('decided_at', null)

  const { error } = await db().from('passkey_requests').insert({
    student_id: row.studentId,
    credential_id: row.credentialId,
    public_key: row.publicKey,
    counter: row.counter,
    transports: row.transports,
    device_label: row.deviceLabel,
    expires_at: new Date(Date.now() + REQUEST_TTL_MS).toISOString(),
    session_id: row.sessionId,
    caller: row.caller,
  })
  // A credential id already in the table means the same phone asked twice.
  if (error && (error as { code?: string }).code !== '23505') throw error
}

export async function pendingRequests(classDate: string | null): Promise<PendingRequest[]> {
  await pruneRequests()
  const { data, error } = await db()
    .from('passkey_requests')
    .select('id, student_id, device_label, requested_at, expires_at')
    .is('decided_at', null)
    .gte('expires_at', new Date().toISOString())
    .order('requested_at', { ascending: true })
  if (error) throw error
  if (!data || data.length === 0) return []

  const students = await listStudents()
  const byId = new Map(students.map((s) => [s.id, s]))

  // Whether they are already marked today is the single most useful hint: a
  // student who has been marked present and is now asking to move their passkey
  // is a very different story from one who has not turned up.
  let marked = new Set<string>()
  if (classDate) {
    const session = await db()
      .from('sessions')
      .select('id')
      .eq('class_date', classDate)
      .maybeSingle()
    if (session.data?.id) {
      const marks = await db()
        .from('attendance')
        .select('student_id')
        .eq('session_id', session.data.id)
      marked = new Set((marks.data ?? []).map((m) => m.student_id))
    }
  }

  return data.flatMap((r) => {
    const student = byId.get(r.student_id)
    if (!student) return []
    return [
      {
        id: r.id,
        studentId: r.student_id,
        rollNo: student.roll_no,
        name: student.name,
        deviceLabel: r.device_label,
        requestedAt: r.requested_at,
        expiresAt: r.expires_at,
        markedToday: marked.has(r.student_id),
      },
    ]
  })
}

export async function requestById(id: string) {
  const { data, error } = await db()
    .from('passkey_requests')
    .select('*')
    .eq('id', id)
    .is('decided_at', null)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function decideRequest(id: string, decision: 'approved' | 'rejected'): Promise<boolean> {
  // Guarded on `decided_at is null`, so two admins tapping at once cannot both
  // apply a decision.
  const { data, error } = await db()
    .from('passkey_requests')
    .update({ decided_at: new Date().toISOString(), decision })
    .eq('id', id)
    .is('decided_at', null)
    .select('id')
  if (error) throw error
  return Boolean(data && data.length > 0)
}

/** Replaces a student's passkey with the approved one. */
export async function replaceCredential(
  studentId: string,
  row: { credentialId: string; publicKey: string; counter: number; transports: string[] | null; deviceLabel: string | null }
): Promise<void> {
  const { error: clearError } = await db()
    .from('student_credentials')
    .delete()
    .eq('student_id', studentId)
  if (clearError) throw clearError
  const saved = await saveCredential({ studentId, ...row })
  if (saved.conflict) throw new Error('approved credential is already registered elsewhere')
}

async function pruneRequests(): Promise<void> {
  await db()
    .from('passkey_requests')
    .delete()
    .lt('requested_at', new Date(Date.now() - REQUEST_KEEP_MS).toISOString())
}
