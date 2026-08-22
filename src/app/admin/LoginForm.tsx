'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

export function LoginForm() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
            ? 'That access code has expired. Ask the instructor for a new one.'
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
      <h1 className="text-xl font-semibold">Instructor sign-in</h1>
      <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
        Your password, or a temporary access code if someone gave you one.
      </p>
      <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          aria-label="Password or access code"
          placeholder="Password or ABCD-EFGH-JKMN"
          autoComplete="off"
          className="rounded-xl border border-slate-300 px-4 py-3 dark:border-slate-700 dark:bg-slate-900"
        />
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
