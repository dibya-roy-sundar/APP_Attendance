'use client'

import { useEffect } from 'react'

/**
 * Registers the service worker so the app is installable and a dropped
 * connection shows our own page rather than the browser's error screen.
 *
 * Registration failing is not worth surfacing — the app works without it.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }
    // Wait for load so registration never competes with the first scan request.
    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })
  }, [])

  return null
}
