'use client'

const KEY = 'att_device'

/**
 * The student's identity. Generated once per phone and never sent anywhere
 * except in a request body; the server maps it to a student, so a roll number
 * from the client is never trusted after enrollment.
 */
export function deviceId(): string {
  try {
    const existing = localStorage.getItem(KEY)
    if (existing) return existing
    const fresh = crypto.randomUUID()
    localStorage.setItem(KEY, fresh)
    return fresh
  } catch {
    // Private browsing with storage disabled: still return something usable for
    // this one request so the scan reports NEEDS_ENROLL rather than crashing.
    return crypto.randomUUID()
  }
}

/**
 * Whether this browser will actually keep the id we just wrote.
 *
 * Safari with "Block All Cookies" — and some private modes — let `setItem`
 * throw, or accept it and hand back nothing. Either way `deviceId()` mints a
 * fresh UUID on every call, so a student who registers here binds a throwaway
 * id: next class the phone is unrecognised, their roll number is already
 * claimed, and they need an admin device reset. Every class.
 *
 * Registration is the only place this matters, and it is worth one write to
 * find out before we promise the student they will never type their roll number
 * again.
 */
export function storagePersists(): boolean {
  try {
    const probe = `${KEY}__probe`
    localStorage.setItem(probe, '1')
    const readBack = localStorage.getItem(probe)
    localStorage.removeItem(probe)
    return readBack === '1'
  } catch {
    return false
  }
}
