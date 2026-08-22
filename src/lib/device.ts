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
    // this one request so the scan reports NOT_REGISTERED rather than crashing.
    return crypto.randomUUID()
  }
}
