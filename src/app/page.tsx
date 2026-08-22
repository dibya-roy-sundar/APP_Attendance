import { ThemeToggle } from '@/components/ThemeToggle'
import Link from 'next/link'

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Soft Skills Attendance</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Scan the QR code projected in class to be marked present.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <Link
          href="/me"
          className="rounded-xl bg-slate-900 px-4 py-3 text-center font-medium text-white dark:bg-white dark:text-slate-900"
        >
          My attendance
        </Link>
        <Link
          href="/admin"
          className="rounded-xl border border-slate-300 px-4 py-3 text-center font-medium dark:border-slate-700"
        >
          Instructor
        </Link>
      </div>
      <ThemeToggle />
    </main>
  )
}
