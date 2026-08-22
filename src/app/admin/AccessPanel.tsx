'use client'

import { useEffect, useState } from 'react'

type Grant = {
  id: string
  label: string
  expiresAt: string
  revokedAt: string | null
  lastUsedAt: string | null
  active: boolean
}

const HOURS = [2, 4, 8, 24] as const

function until(iso: string) {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'expired'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`
}

/**
 * Hand someone temporary access while you are away.
 *
 * They can run a class — start and stop sessions, project the QR, mark
 * attendance — and download a view-only copy of the register. They cannot reset
 * a device, change the registration window, or pass access on. Revoking takes
 * effect on their next request.
 */
export function AccessPanel() {
  const [grants, setGrants] = useState<Grant[] | null>(null)
  const [label, setLabel] = useState('')
  const [hours, setHours] = useState<number>(8)
  const [issued, setIssued] = useState<{ code: string; label: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Bumping the key refetches; the effect owns every write to `grants`.
  const [reloadKey, setReloadKey] = useState(0)
  const reload = () => setReloadKey((k) => k + 1)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/grants', { cache: 'no-store' })
        if (!cancelled && res.ok) setGrants((await res.json()).grants)
      } catch {
        if (!cancelled) setGrants([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  async function issue() {
    if (!label.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/grants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim(), hours }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(
          data.error === 'MISSING_LABEL'
            ? 'Give the code a name so you know who has it.'
            : data.error === 'BAD_HOURS'
              ? 'Choose between 1 hour and 7 days.'
              : 'Could not issue access.'
        )
        return
      }
      setIssued({ code: data.code, label: data.grant.label })
      setLabel('')
      reload()
    } catch {
      setError('No connection.')
    } finally {
      setBusy(false)
    }
  }

  async function revoke(id: string) {
    setBusy(true)
    try {
      await fetch('/api/grants/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grantId: id }),
      })
      reload()
    } finally {
      setBusy(false)
    }
  }

  const active = grants?.filter((g) => g.active) ?? []

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-medium">Temporary access</p>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          For a day you are away. They can run the class and download a view-only
          sheet — but never reset a device, change registration, or pass access
          on.
        </p>
      </div>

      {issued && (
        <div className="rounded-lg bg-emerald-50 p-3 ring-1 ring-emerald-500/30 dark:bg-emerald-950/40">
          <p className="text-xs text-slate-600 dark:text-slate-300">
            Give this to <strong>{issued.label}</strong>. It is shown once — if it
            is lost, revoke it and issue another.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded bg-white px-2.5 py-1.5 font-mono text-base tracking-widest dark:bg-slate-900">
              {issued.code}
            </code>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(issued.code)
                  setCopied(true)
                } catch {
                  setCopied(false)
                }
              }}
              className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs dark:border-slate-700"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              onClick={() => {
                setIssued(null)
                setCopied(false)
              }}
              className="inline-flex min-h-11 items-center px-1 text-xs text-slate-500 dark:text-slate-400 underline"
            >
              Done
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            They sign in at /admin with this code instead of a password.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-40 flex-1 text-xs text-slate-500 dark:text-slate-400">
          Who is covering
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Anita (TA)"
            className="mt-1 block w-full rounded-lg border border-slate-300 bg-transparent px-2.5 py-1.5 text-base dark:border-slate-700"
          />
        </label>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          For
          <div className="mt-1 flex gap-1">
            {HOURS.map((h) => (
              <button
                key={h}
                onClick={() => setHours(h)}
                aria-pressed={hours === h}
                className={`rounded-lg px-2.5 py-1.5 text-sm tabular-nums ${
                  hours === h
                    ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                    : 'border border-slate-300 dark:border-slate-700'
                }`}
              >
                {h}h
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={issue}
          disabled={busy || !label.trim()}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-slate-700"
        >
          Issue code
        </button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="border-t border-slate-200 pt-3 dark:border-slate-800">
        <p className="text-sm font-medium">
          Active access{active.length > 0 ? ` (${active.length})` : ''}
        </p>
        {grants === null ? (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Loading…</p>
        ) : active.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Nobody else has access.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {active.map((g) => (
              <li key={g.id} className="flex items-center gap-3 text-xs">
                <span className="flex-1 truncate">
                  <strong className="font-medium">{g.label}</strong>
                  <span className="text-slate-500 dark:text-slate-400">
                    {' · '}
                    {until(g.expiresAt)}
                    {g.lastUsedAt ? ' · used' : ' · not used yet'}
                  </span>
                </span>
                <button
                  onClick={() => revoke(g.id)}
                  disabled={busy}
                  className="inline-flex min-h-11 shrink-0 items-center px-1 underline disabled:opacity-40"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
