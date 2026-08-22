'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

export function LoginForm() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [visible, setVisible] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (res.ok) {
        router.refresh()
      } else {
        const body = await res.json().catch(() => ({}))
        setError(
          body.error === 'CODE_EXPIRED'
            ? 'That access code has expired. Ask the admin for a new one.'
            : body.error === 'CODE_REVOKED'
              ? 'That access code was revoked.'
              : 'Wrong password or code.'
        )
        setPassword('')
      }
    } catch {
      setError('No connection.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center p-6">
      <h1 className="text-xl font-semibold">Admin sign-in</h1>
      <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
        Your password, or a temporary access code if someone gave you one.
      </p>
      <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
        <div className="relative">
          <input
            type={visible ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            aria-label="Password or access code"
            placeholder="Password or ABCD-EFGH-JKMN"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="w-full rounded-xl border border-slate-300 py-3 pl-4 pr-14 dark:border-slate-700 dark:bg-slate-900"
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? 'Hide password' : 'Show password'}
            aria-pressed={visible}
            className="tap-square absolute inset-y-0 right-0 flex items-center justify-center px-3 text-slate-500 dark:text-slate-400"
          >
            {visible ? (
              // Eye with a slash: currently visible, tap to hide.
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                <path d="M3 3l18 18" />
                <path d="M10.6 5.2A9.6 9.6 0 0 1 12 5c5 0 9 4.5 9 7 0 .8-.5 1.9-1.4 3" />
                <path d="M6.3 6.8C3.9 8.4 3 10.4 3 12c0 2.5 4 7 9 7 1.7 0 3.2-.5 4.5-1.3" />
                <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                <path d="M3 12c0-2.5 4-7 9-7s9 4.5 9 7-4 7-9 7-9-4.5-9-7z" />
                <circle cx="12" cy="12" r="2.6" />
              </svg>
            )}
          </button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !password}
          className="rounded-xl bg-slate-900 px-4 py-3 font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
        >
          {busy ? 'Checking…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
