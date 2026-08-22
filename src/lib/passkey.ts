import { canonicalOrigin } from '@/lib/origin'
import { db } from '@/lib/supabase'

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
