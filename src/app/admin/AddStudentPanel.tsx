'use client'

import { useState } from 'react'

/**
 * Adds one student to the roster.
 *
 * Deliberately plain: three fields, one button. Adding students is a handful of
 * events a term, so there is nothing to gain from bulk import or inline editing
 * that would not also add ways to damage the register.
 */
export function AddStudentPanel({
  onAdded,
}: {
  onAdded: (summary: string) => void
}) {
  const [rollNo, setRollNo] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ready = rollNo.trim().length > 0 && name.trim().length > 0

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rollNo: rollNo.trim(),
          name: name.trim(),
          email: email.trim() || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(
          data.error === 'ROLL_TAKEN'
            ? 'That roll number is already on the roster.'
            : data.error === 'BAD_ROLL'
              ? 'Roll numbers use letters, digits, dots, slashes and dashes only.'
              : data.error === 'BAD_NAME'
                ? 'Give the student a name.'
                : data.error === 'BAD_EMAIL'
                  ? 'That email address does not look right.'
                  : 'Could not add that student.'
        )
        return
      }
      const s = data.student as { sNo: number; rollNo: string; name: string }
      setRollNo('')
      setName('')
      setEmail('')
      onAdded(`${s.name} added as S.No ${s.sNo} (${s.rollNo}).`)
    } catch {
      setError('No connection.')
    } finally {
      setBusy(false)
    }
  }

  // noValidate on purpose. `type="email"` is kept for the mobile keyboard, but
  // the browser's own validation would otherwise block submission before this
  // handler runs — no request, no styled message, and whatever error was already
  // on screen stays there looking like the answer. One place decides what is
  // wrong, and it is the server.
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3">
      <div>
        <p className="text-sm font-medium">Add a student</p>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          They join at the end of the roster and of the exported sheet. Classes
          already held stay blank for them.
        </p>
      </div>

      <label className="text-xs text-slate-500 dark:text-slate-400">
        Roll number
        <input
          value={rollNo}
          onChange={(e) => setRollNo(e.target.value)}
          placeholder="MT2026999"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          className="mt-1 block w-full rounded-xl border border-slate-300 bg-transparent px-3 py-2 text-base tracking-wide dark:border-slate-700"
        />
      </label>

      <label className="text-xs text-slate-500 dark:text-slate-400">
        Full name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Asha Menon"
          autoCapitalize="words"
          className="mt-1 block w-full rounded-xl border border-slate-300 bg-transparent px-3 py-2 text-base dark:border-slate-700"
        />
      </label>

      <label className="text-xs text-slate-500 dark:text-slate-400">
        Email (optional)
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="asha.menon@iiitb.ac.in"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="email"
          className="mt-1 block w-full rounded-xl border border-slate-300 bg-transparent px-3 py-2 text-base dark:border-slate-700"
        />
      </label>

      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={!ready || busy}
        className="min-h-11 rounded-xl bg-slate-900 px-4 font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
      >
        {busy ? 'Adding…' : 'Add student'}
      </button>
    </form>
  )
}
