import { randomBytes } from 'node:crypto'
import type { AuditAction, SessionRow, StudentRow } from './database.types'
import { classDate } from './dates'
import { env } from './env'
import { db } from './supabase'

/** Session length used when the admin does not choose one. */
export const DEFAULT_SESSION_MINUTES = 30

/**
 * Bounds on session length. One minute is the shortest useful window; ten hours
 * covers any single teaching day without letting a typo leave a QR live for a
 * week.
 */
export const MIN_SESSION_MINUTES = 1
export const MAX_SESSION_MINUTES = 600

export function isValidSessionMinutes(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= MIN_SESSION_MINUTES &&
    v <= MAX_SESSION_MINUTES
  )
}

/** How the roster grid renders one student. `secret` never leaves the server. */
export type RosterEntry = {
  studentId: string
  sNo: number
  rollNo: string
  name: string
  /** True when they hold at least one passkey. */
  enrolled: boolean
  /** How many passkeys — one per device they have set up. */
  passkeys: number
  markedAt: string | null
  source: 'scan' | 'manual' | null
  /** True for the instructor's own row — they are one of the 47. */
  isSelf: boolean
}

export type PublicSession = {
  id: string
  classDate: string
  isOpen: boolean
  openedAt: string
  expiresAt: string
  /** false for a backdated session — no QR is ever generated for one. */
  scannable: boolean
  /** QR rotation period in seconds. */
  windowSeconds: number
}

export function toPublicSession(s: SessionRow): PublicSession {
  const live = s.is_open && new Date(s.expires_at).getTime() > Date.now()
  return {
    id: s.id,
    classDate: s.class_date,
    isOpen: s.is_open,
    openedAt: s.opened_at,
    expiresAt: s.expires_at,
    scannable: live,
    windowSeconds: s.window_seconds,
  }
}

export async function getSessionById(id: string): Promise<SessionRow | null> {
  const { data, error } = await db().from('sessions').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}

export async function getSessionByDate(date: string): Promise<SessionRow | null> {
  const { data, error } = await db()
    .from('sessions')
    .select('*')
    .eq('class_date', date)
    .maybeSingle()
  if (error) throw error
  return data
}

/** The session the admin most likely wants: today's if it exists, else the newest. */
export async function getDefaultSession(): Promise<SessionRow | null> {
  const today = await getSessionByDate(classDate())
  if (today) return today
  const { data, error } = await db()
    .from('sessions')
    .select('*')
    .order('class_date', { ascending: false })
    .limit(1)
  if (error) throw error
  return data?.[0] ?? null
}

export async function listSessions(): Promise<SessionRow[]> {
  const { data, error } = await db()
    .from('sessions')
    .select('*')
    .order('class_date', { ascending: true })
  if (error) throw error
  return data ?? []
}

/*
 * The roster is read on nearly every request but changes a handful of times a
 * term, so it is worth not fetching 47 rows each time.
 *
 * The TTL is seconds, not days. This process is one serverless instance among
 * several, and there is no way to tell the others that a student was added — so
 * a long TTL would mean an instance serving a roster that is wrong for as long
 * as the TTL lasts. Thirty seconds keeps every instance close to the truth
 * without another moving part; the instance that performs a write clears its own
 * copy immediately, so the admin who added someone always sees them.
 *
 * The honest gain is narrower than it looks: in `/api/roster` this query already
 * runs in parallel with three others, so caching it saves nothing there. It pays
 * off where the lookup is sequential — marking, enrolling, issuing access.
 */
const STUDENT_CACHE_MS = 30_000
let studentCache: { rows: StudentRow[]; at: number } | null = null

/** Called by anything that writes to `students`. */
export function invalidateStudents(): void {
  studentCache = null
}

export async function listStudents(): Promise<StudentRow[]> {
  const now = Date.now()
  if (studentCache && now - studentCache.at < STUDENT_CACHE_MS) {
    return studentCache.rows
  }
  const { data, error } = await db()
    .from('students')
    .select('*')
    .order('s_no', { ascending: true })
  if (error) throw error
  const rows = data ?? []
  studentCache = { rows, at: now }
  return rows
}

/** The next sheet position, so an added student lands at the end of the list. */
export async function nextStudentNumber(): Promise<number> {
  const { data, error } = await db()
    .from('students')
    .select('s_no')
    .order('s_no', { ascending: false })
    .limit(1)
  if (error) throw error
  return (data?.[0]?.s_no ?? 0) + 1
}

/** Longest roll number worth considering; anything longer is not a typo. */
export const MAX_ROLL_LENGTH = 32

/**
 * Exact, case-insensitive lookup by roll number.
 *
 * Deliberately compared in JS rather than with `ilike`: in SQL LIKE, `%` and `_`
 * are wildcards, so `MT202652_` would have matched a real student and let the
 * caller enrol as them. Matching 47 rows in memory removes that entire class of
 * bug rather than trying to escape around it.
 */
/** By primary key. Used after a passkey names its owner via userHandle. */
export async function getStudentById(id: string): Promise<StudentRow | null> {
  if (!isUuidish(id)) return null
  const { data, error } = await db().from('students').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}

function isUuidish(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

export async function getStudentByRollNo(rollNo: string): Promise<StudentRow | null> {
  const target = rollNo.trim().toLowerCase()
  if (!target || target.length > MAX_ROLL_LENGTH) return null

  // Resolve the roll number against the cached roster: a roll number never
  // changes which row it belongs to, so that mapping is safe to cache.
  const students = await listStudents()
  const match = students.find((s) => s.roll_no.trim().toLowerCase() === target)
  if (!match) return null

  /*
   * Then read that one row live, because `device_id` is mutable and this
   * decides whether a claim is allowed.
   *
   * Serving it from cache is wrong across instances: the admin taps Reset
   * device, their instance clears its copy, and the student's very next request
   * lands on a different instance still holding the old binding — which would
   * tell a student the admin had just freed that their roll number is "already
   * registered on another phone". One indexed lookup avoids that entirely.
   */
  const { data, error } = await db()
    .from('students')
    .select('*')
    .eq('id', match.id)
    .maybeSingle()
  if (error) throw error
  return data
}

/*
 * SUPERSEDED BY PASSKEYS — kept for the record, called by nothing.
 *
 * This was the whole of identity: a random UUID the browser generated once and
 * kept in localStorage, looked up here to decide who was scanning. It failed in
 * three ways that no amount of care in this function could fix.
 *
 *   1. Safari deletes script-writable storage after about seven days of browser
 *      use without interaction on the site. A weekly class sits exactly on that
 *      boundary, so the roster would silently lose its bindings between classes.
 *   2. An installed home-screen web app on iOS gets its own storage container,
 *      so the same phone could hold two unrelated identities and only one of
 *      them could own the roll number.
 *   3. Anything the browser can read, the student can copy and send to a friend.
 *
 * A passkey lives in the OS credential store instead, survives all three, and
 * cannot be forwarded: no page can read the private key, and it moves between a
 * student's own devices only inside the provider's encrypted sync. See README,
 * "Why identity moved from localStorage to a cookie to passkeys".
 *
 * export async function getStudentByDevice(deviceId: string): Promise<StudentRow | null> {
 *   const { data, error } = await db()
 *     .from('students')
 *     .select('*')
 *     .eq('device_id', deviceId)
 *     .maybeSingle()
 *   if (error) throw error
 *   return data
 * }
 */

/**
 * All 47 students, in sheet order, annotated with their mark for this session.
 * `sessionId` may be null — before the term's first session there is nothing to
 * mark, but the admin still needs to see that the roster loaded.
 */
export async function getRoster(
  sessionId: string | null,
  /**
   * Whether to flag the instructor's own row. Off for a deputy: ADMIN_ROLL_NO
   * names who the instructor is, which says nothing about who is signed in, so
   * a stand-in would otherwise see "you" on somebody else's row.
   */
  markSelf = false
): Promise<RosterEntry[]> {
  const [students, marks, credentials] = await Promise.all([
    listStudents(),
    sessionId
      ? db().from('attendance').select('student_id, marked_at, source').eq('session_id', sessionId)
      : Promise.resolve({ data: [], error: null } as const),
    // How many passkeys each student holds. Counted rather than treated as a
    // boolean because a student may register one per device, and seeing "2
    // passkeys" is how an admin can tell a phone change from a problem.
    db().from('student_credentials').select('student_id'),
  ])
  if (marks.error) throw marks.error
  if (credentials.error) throw credentials.error
  const byStudent = new Map(marks.data?.map((m) => [m.student_id, m]) ?? [])
  const passkeyCount = new Map<string, number>()
  for (const c of credentials.data ?? []) {
    passkeyCount.set(c.student_id, (passkeyCount.get(c.student_id) ?? 0) + 1)
  }
  const selfRoll = env.adminRollNo?.toLowerCase() ?? null
  return students.map((s) => {
    const mark = byStudent.get(s.id)
    return {
      studentId: s.id,
      sNo: s.s_no,
      rollNo: s.roll_no,
      name: s.name,
      // "Enrolled" now means "holds at least one passkey". The old meaning —
      // students.device_id being non-null — is superseded; see docs/superseded/.
      passkeys: passkeyCount.get(s.id) ?? 0,
      enrolled: (passkeyCount.get(s.id) ?? 0) > 0,
      markedAt: mark?.marked_at ?? null,
      source: (mark?.source as 'scan' | 'manual' | undefined) ?? null,
      isSelf: markSelf && selfRoll !== null && s.roll_no.toLowerCase() === selfRoll,
    }
  })
}

export function newSecret(): string {
  return randomBytes(32).toString('hex')
}

export async function audit(entry: {
  action: AuditAction
  studentId?: string | null
  sessionId?: string | null
  reason?: string | null
  /** 'primary' or 'deputy:<label>' — who took the action. */
  actor?: string | null
}): Promise<void> {
  const { error } = await db().from('audit_log').insert({
    action: entry.action,
    student_id: entry.studentId ?? null,
    session_id: entry.sessionId ?? null,
    reason: entry.reason ?? null,
    actor: entry.actor ?? null,
  })
  // The log is evidence, not a gate: a failed write must not fail the action
  // the admin just took.
  if (error) console.error('audit_log write failed', error)
}
