import { NextResponse } from 'next/server'
import { type Principal, currentPrincipal } from './admin'

export function ok<T extends object>(body: T, status = 200) {
  return NextResponse.json(body, { status })
}

export function fail(error: string, status = 400, extra: object = {}) {
  return NextResponse.json({ error, ...extra }, { status })
}

/**
 * The result of a route's authorisation check. Carrying the principal through
 * means a route reads the cookie once, rather than checking access and then
 * separately asking who is calling.
 */
export type Guard =
  | { ok: true; principal: Principal }
  | { ok: false; response: NextResponse }

/** Any signed-in admin: the instructor, or a deputy covering for them. */
export async function guardAdmin(): Promise<Guard> {
  const principal = await currentPrincipal()
  if (!principal) return { ok: false, response: fail('UNAUTHORIZED', 401) }
  return { ok: true, principal }
}

/**
 * The instructor only. Guards the operations a stand-in must never perform:
 * device resets, the enrollment window, and handing out further access.
 */
export async function guardPrimary(): Promise<Guard> {
  const principal = await currentPrincipal()
  if (!principal) return { ok: false, response: fail('UNAUTHORIZED', 401) }
  if (principal.kind !== 'primary') {
    return { ok: false, response: fail('FORBIDDEN', 403) }
  }
  return { ok: true, principal }
}

/** Parses a JSON body without throwing on empty or malformed input. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A device id is only ever a UUID we generated on the client. */
export function isDeviceId(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v)
}

/**
 * Validates a device id and folds it to lowercase, or returns null.
 *
 * The fold matters: the UUID pattern is case-insensitive but Postgres equality
 * and the unique index on `students.device_id` are not. Without normalising,
 * `ABC…` would pass validation, fail to match the stored `abc…`, and — with the
 * enrollment window open — let one phone claim a second student. `randomUUID()`
 * only ever emits lowercase, so this is a guard against drift rather than a live
 * defect.
 */
export function normaliseDeviceId(v: unknown): string | null {
  return isDeviceId(v) ? v.toLowerCase() : null
}

export function isUuid(v: unknown): v is string {
  return isDeviceId(v)
}
