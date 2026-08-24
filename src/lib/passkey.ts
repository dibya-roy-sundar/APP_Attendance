import { canonicalOrigin } from '@/lib/origin'
import { db } from '@/lib/supabase'
import { listStudents } from '@/lib/data'

/**
 * Passkeys are the app's identity. See docs/identity.md for why this replaced the
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

/**
 * Every credential the class holds, for excludeCredentials.
 *
 * Not just the roll number being claimed. WebAuthn refuses to tell a page
 * whether a passkey exists — deliberately, since that would be an enumeration
 * and tracking vector — so the page cannot enforce "one passkey per phone"
 * itself. excludeCredentials can: the authenticator checks the list against
 * what it already holds and throws InvalidStateError rather than creating a
 * second key. Listing the whole class therefore makes a phone that already
 * carries any student's passkey unable to enrol another.
 *
 * This is enforced by the phone, not by us. A caller scripting WebAuthn by hand
 * can drop the list, and the server cannot tell — a platform authenticator
 * reports no device identity by design, and the AAGUID names a model, not a
 * handset. So this stops a student with a phone, which is the threat here, and
 * does not stop someone writing their own client.
 *
 * The ids are opaque random bytes and reveal no roll numbers; the size of the
 * list does reveal how many students have enrolled, which is not worth hiding
 * from somebody already holding a live QR token. At 47 students the payload is
 * a few kilobytes. A class in the thousands would want reconsidering, because
 * CTAP2 limits how large this list can get.
 */
export async function allCredentials(): Promise<
  { credential_id: string; transports: string[] | null }[]
> {
  const { data, error } = await db()
    .from('student_credentials')
    .select('credential_id, transports')
  if (error) throw error
  return data ?? []
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

/** How long an undecided claim stays actionable. */
const REQUEST_TTL_MS = 3 * 24 * 60 * 60 * 1000
/** How much recent history the panel shows, and how long rows are kept. */
const HISTORY_MS = 7 * 24 * 60 * 60 * 1000

export type RequestRow = {
  id: string
  studentId: string
  rollNo: string
  name: string
  deviceLabel: string | null
  requestedAt: string
  expiresAt: string
  /** null while it is still waiting. */
  decision: 'approved' | 'rejected' | null
  decidedAt: string | null
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

/**
 * The last week of claims, whatever became of them.
 *
 * Deliberately just the facts: who asked, from what, when, and what was
 * decided. There is no attempt to guess which claims are honest.
 *
 * An earlier version showed whether the student was already marked present, and
 * when their existing passkey last worked. Both were dropped because they do not
 * discriminate where it matters: a proxy attempt happens while the student is
 * absent, and so does a genuine lost phone, so the common case for both looks
 * identical. A flag that only fires in the rare case is worse than none, because
 * it invites trusting it instead of asking the student — and the admin is in the
 * room with all 47 of them, which is a better instrument than any heuristic.
 *
 * The permanent record is audit_log, which keeps every PASSKEY_REQUESTED,
 * PASSKEY_APPROVED and PASSKEY_REJECTED for good. This table is only the
 * working queue and its recent history, so it can be pruned freely.
 *
 * The window is enforced here, by the query. Cleanup is therefore housekeeping
 * rather than correctness — a row past the window is invisible whether or not
 * it has been deleted yet — so the caller fires pruneRequests() after the
 * response instead of making the admin wait on a DELETE.
 */
export async function recentRequests(): Promise<RequestRow[]> {
  const since = new Date(Date.now() - HISTORY_MS).toISOString()
  const { data, error } = await db()
    .from('passkey_requests')
    .select('id, student_id, device_label, requested_at, expires_at, decision, decided_at')
    .gte('requested_at', since)
    .order('requested_at', { ascending: false })
  if (error) throw error
  if (!data || data.length === 0) return []

  const students = await listStudents()
  const byId = new Map(students.map((s) => [s.id, s]))

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
        decision: r.decision,
        decidedAt: r.decided_at,
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

/**
 * Drops anything past the window the panel shows.
 *
 * No scheduler. This is fired after the panel's response is sent, which is the
 * only place the queue is ever read — proportionate for a table holding a
 * handful of rows a term, and one less thing that can silently stop running.
 * Nothing is lost either way: audit_log keeps every request and decision
 * permanently, and recentRequests() filters by date regardless, so a row that
 * survives a failed cleanup is still invisible.
 *
 * Failure is swallowed by the caller on purpose. There is no user-facing
 * consequence to a delete that did not happen, and an error here must never
 * turn a working panel into a broken one.
 */
export async function pruneRequests(): Promise<void> {
  await db()
    .from('passkey_requests')
    .delete()
    .lt('requested_at', new Date(Date.now() - HISTORY_MS).toISOString())
}
