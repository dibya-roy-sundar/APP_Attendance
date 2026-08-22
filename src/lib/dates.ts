import { env } from './env'

/** `YYYY-MM-DD` for the given instant in the class's timezone. */
export function classDate(at: Date = new Date(), timeZone = env.classTimezone): string {
  // en-CA gives ISO-ordered parts, so this is a plain YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
}

/** True for a well-formed calendar date string. */
export function isValidDateString(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** e.g. `21 Aug 2026` — how dates read in the UI. */
export function formatDisplayDate(dateStr: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${dateStr}T00:00:00Z`))
}

/** Clock time of a mark, in the class timezone: `12:04`. */
export function formatClockTime(iso: string, timeZone = env.classTimezone): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}
