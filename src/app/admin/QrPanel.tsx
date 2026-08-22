'use client'

import QRCode from 'qrcode'
import { useEffect, useRef, useState } from 'react'

/**
 * Projects the rotating code. The secret stays on the server: this polls
 * /api/token for the current 12-character token and redraws, so a browser with
 * this page open cannot mint codes for any other window.
 */
export function QrPanel({
  sessionId,
  fullscreen,
  onClose,
}: {
  sessionId: string
  fullscreen: boolean
  onClose?: () => void
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [rotation, setRotation] = useState<number | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false

    async function tick() {
      try {
        const res = await fetch(`/api/token?s=${encodeURIComponent(sessionId)}`, {
          cache: 'no-store',
        })
        if (cancelled) return
        if (res.status === 401) {
          setError('Signed out. Reload the page.')
          return
        }
        if (!res.ok) {
          setError('Session is closed.')
          return
        }
        const { scanUrl, refreshInMs, windowSeconds } = await res.json()
        // Server-built. Never window.location.origin: a production deployment
        // answers on both its immutable URL and the project alias, and the
        // device binding in localStorage belongs to whichever one the student
        // landed on.
        const target = scanUrl
        setUrl(target)
        setRotation(windowSeconds)
        setDataUrl(
          await QRCode.toDataURL(target, {
            errorCorrectionLevel: 'M',
            margin: 1,
            width: 1024,
            color: { dark: '#000000ff', light: '#ffffffff' },
          })
        )
        setError(null)
        // Re-fetch just after the window flips, plus a little slack for clock
        // skew, rather than on a blind 15s interval.
        if (!cancelled) timer.current = setTimeout(tick, Math.max(500, refreshInMs + 300))
      } catch {
        if (!cancelled) timer.current = setTimeout(tick, 2000)
      }
    }

    void tick()
    return () => {
      cancelled = true
      if (timer.current) clearTimeout(timer.current)
    }
  }, [sessionId])

  useEffect(() => {
    if (!fullscreen || !onClose) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen, onClose])

  const image = dataUrl ? (
    // A data: URL of a QR code — next/image would only add a proxy hop.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={dataUrl}
      alt="Attendance QR code"
      className={fullscreen ? 'w-[min(72vh,88vw)]' : 'w-full max-w-64'}
    />
  ) : (
    <div
      className={`aspect-square animate-pulse rounded-xl bg-slate-200 dark:bg-slate-800 ${
        fullscreen ? 'w-[min(72vh,88vw)]' : 'w-full max-w-64'
      }`}
    />
  )

  if (!fullscreen) {
    return (
      <div className="flex flex-col items-center gap-2">
        {image}
        {error && <p className="text-sm text-amber-600">{error}</p>}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 overflow-hidden bg-white p-4 dark:bg-black">
      <p className="max-w-full text-center text-base font-medium sm:text-lg">
        Scan to mark attendance
        {rotation ? ` — code changes every ${rotation} seconds` : ''}
      </p>
      {image}
      {error ? (
        <p className="text-amber-600">{error}</p>
      ) : (
        <p className="w-full truncate text-center font-mono text-[10px] text-slate-500 dark:text-slate-400 sm:text-xs">
          {url}
        </p>
      )}
      <button
        onClick={onClose}
        className="rounded-xl border border-slate-300 px-6 py-3 font-medium dark:border-slate-700"
      >
        Close
      </button>
    </div>
  )
}
