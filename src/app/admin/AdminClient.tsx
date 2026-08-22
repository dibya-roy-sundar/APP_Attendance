"use client";

import { Spinner } from "@/components/Spinner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Controls } from "./Controls";
import { QrPanel } from "./QrPanel";

type Student = {
  studentId: string;
  sNo: number;
  rollNo: string;
  name: string;
  enrolled: boolean;
  markedAt: string | null;
  source: "scan" | "manual" | null;
  isSelf: boolean;
};

type Session = {
  id: string;
  classDate: string;
  isOpen: boolean;
  openedAt: string;
  expiresAt: string;
  scannable: boolean;
  windowSeconds: number;
};

type Roster = {
  session: Session | null;
  students: Student[];
  markedCount: number;
  total: number;
  enrollmentOpen: boolean;
  sessions: { id: string; classDate: string; isOpen: boolean }[];
  today: string;
  role: "primary" | "deputy";
  deputyLabel: string | null;
  deputyExpiresAt: string | null;
};

const POLL_MS = 5000;
const REASONS = ["phone dead", "late", "correction"] as const;

function formatDate(d: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  }).format(new Date(`${d}T00:00:00Z`));
}

function formatTime(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function countdown(expiresAt: string, now: number) {
  const left = Math.max(0, new Date(expiresAt).getTime() - now);
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function AdminClient() {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Student whose reason chips are showing, and which way the tap went. */
  const [reasonFor, setReasonFor] = useState<{
    studentId: string;
    marked: boolean;
  } | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** Rows with an in-flight toggle; their optimistic state must survive a poll. */
  const pending = useRef<Set<string>>(new Set());

  const load = useCallback(async (sessionId?: string | null) => {
    const qs = sessionId ? `?s=${encodeURIComponent(sessionId)}` : "";
    const res = await fetch(`/api/roster${qs}`, { cache: "no-store" });
    if (res.status === 401) {
      window.location.reload(); // cookie expired mid-class
      return;
    }
    if (!res.ok) return;
    const data: Roster = await res.json();
    setRoster((prev) => {
      if (!prev || pending.current.size === 0) return data;
      // Keep optimistic rows as they are until their request settles.
      return {
        ...data,
        students: data.students.map((s) => {
          if (!pending.current.has(s.studentId)) return s;
          return prev.students.find((p) => p.studentId === s.studentId) ?? s;
        }),
      };
    });
    if (!sessionId && data.session) setSelectedId(data.session.id);
  }, []);

  useEffect(() => {
    void load(selectedId);
    const id = setInterval(() => void load(selectedId), POLL_MS);
    return () => clearInterval(id);
  }, [load, selectedId]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const session = roster?.session ?? null;
  const markedCount = useMemo(
    () => roster?.students.filter((s) => s.markedAt).length ?? 0,
    [roster],
  );

  async function toggle(student: Student, reason?: string) {
    if (!session) return;
    const wasMarked = Boolean(student.markedAt);
    pending.current.add(student.studentId);

    // Optimistic: the tap has to feel instant with 47 rows on a projector.
    setRoster((prev) =>
      prev
        ? {
            ...prev,
            students: prev.students.map((s) =>
              s.studentId === student.studentId
                ? {
                    ...s,
                    markedAt: wasMarked ? null : new Date().toISOString(),
                    source: wasMarked ? null : "manual",
                  }
                : s,
            ),
          }
        : prev,
    );
    if (!reason)
      setReasonFor({ studentId: student.studentId, marked: !wasMarked });

    try {
      const res = await fetch("/api/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: student.studentId,
          sessionId: session.id,
          reason,
        }),
      });
      if (!res.ok) throw new Error("toggle failed");
      const body = await res.json();
      // Reconcile against what the server actually recorded.
      setRoster((prev) =>
        prev
          ? {
              ...prev,
              students: prev.students.map((s) =>
                s.studentId === student.studentId
                  ? { ...s, markedAt: body.markedAt, source: body.source }
                  : s,
              ),
            }
          : prev,
      );
    } catch {
      setNotice("That change did not save. Tap again.");
      setRoster((prev) =>
        prev
          ? {
              ...prev,
              students: prev.students.map((s) =>
                s.studentId === student.studentId ? student : s,
              ),
            }
          : prev,
      );
    } finally {
      pending.current.delete(student.studentId);
    }
  }

  async function post(url: string, body: object) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, data };
    } catch {
      setNotice("No connection.");
      return { ok: false, data: {} as Record<string, unknown> };
    } finally {
      setBusy(false);
    }
  }

  async function startSession(opts: {
    classDate?: string;
    durationMinutes: number;
    windowSeconds: number;
  }) {
    const { ok, data } = await post("/api/sessions", opts);
    if (ok) {
      const created = (data as { session: Session }).session;
      setSelectedId(created.id);
      await load(created.id);
      return;
    }
    const err = data as { error?: string; session?: Session };
    if (err.error === "DATE_HAS_SESSION" && err.session) {
      // The intent is "get me to that day's grid", so go there.
      setNotice(
        `${formatDate(err.session.classDate)} already has a session — opened it.`,
      );
      setSelectedId(err.session.id);
      await load(err.session.id);
    } else if (err.error === "FUTURE_DATE") {
      setNotice("That date is in the future.");
    } else if (err.error === "BAD_DATE") {
      setNotice("Pick a valid date.");
    } else if (err.error === "BAD_DURATION") {
      setNotice("Pick a duration between 1 minute and 10 hours.");
    } else if (err.error === "BAD_WINDOW") {
      setNotice("QR rotation must be between 5 and 300 seconds.");
    } else {
      setNotice("Could not start a session.");
    }
  }

  async function setSessionOpen(
    open: boolean,
    opts: { minutes?: number; windowSeconds?: number } = {},
  ) {
    if (!session) return;
    const { ok, data } = await post("/api/sessions/state", {
      sessionId: session.id,
      open,
      ...opts,
    });
    if (!ok) {
      const err = (data as { error?: string }).error;
      setNotice(
        err === "NOT_TODAY"
          ? "Only today's session can be resumed."
          : err === "BAD_DURATION"
            ? "Pick a duration between 1 minute and 10 hours."
            : err === "BAD_WINDOW"
              ? "QR rotation must be between 5 and 300 seconds."
              : "Could not change the session.",
      );
      return;
    }
    const result = data as { session: Session; extended: boolean };
    if (!open) {
      setShowQr(false);
      setNotice("Session stopped. You can still tap the grid.");
    } else if (opts.minutes) {
      setNotice(
        result.extended
          ? `Extended by ${opts.minutes} min.`
          : `Session running for ${opts.minutes} min.`,
      );
    } else if (opts.windowSeconds) {
      setNotice(`QR now rotates every ${opts.windowSeconds} seconds.`);
    }
    await load(session.id);
  }

  async function toggleEnrollment() {
    if (!roster) return;
    const { ok } = await post("/api/enrollment", {
      open: !roster.enrollmentOpen,
    });
    if (ok) await load(selectedId);
    else setNotice("Could not change the registration window.");
  }

  async function resetDevice(student: Student) {
    setMenuFor(null);
    const { ok } = await post("/api/reset-device", {
      studentId: student.studentId,
    });
    setNotice(
      ok
        ? `${student.name} can register a new phone on the next scan.`
        : "Could not reset that device.",
    );
    if (ok) await load(selectedId);
  }

  if (!roster) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <Spinner label="Loading roster…" />
      </main>
    );
  }

  const live = session?.scannable ?? false;

  return (
    <main className="mx-auto max-w-3xl pb-24">
      {showQr && session && live && (
        <QrPanel
          sessionId={session.id}
          fullscreen
          onClose={() => setShowQr(false)}
        />
      )}

      <header className="sticky top-0 z-20 border-b border-slate-200 bg-[var(--background)]/95 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur dark:border-slate-800">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="min-w-0 truncate text-lg font-semibold">
            Soft Skills
            {session && (
              <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
                {formatDate(session.classDate)}
              </span>
            )}
          </h1>
          <p className="shrink-0 text-sm tabular-nums text-slate-500 dark:text-slate-400">
            {markedCount} / {roster.total} marked
          </p>
        </div>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          {!session ? (
            "No session yet"
          ) : live ? (
            <span className="text-emerald-700 dark:text-emerald-400">
              Session live · {countdown(session.expiresAt, now)} remaining · QR
              every {session.windowSeconds}s
            </span>
          ) : session.isOpen ? (
            "Session expired"
          ) : (
            "Session closed — taps still recorded"
          )}
        </p>
      </header>

      {roster.role === "deputy" && (
        <div className="mx-4 mt-3 rounded-xl bg-amber-50 px-4 py-3 text-sm ring-1 ring-amber-500/30 dark:bg-amber-950/40">
          <p className="font-medium">
            Temporary access as {roster.deputyLabel}
          </p>
          <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">
            You can run the class and download a view-only sheet.
            {roster.deputyExpiresAt
              ? ` Access ends ${new Intl.DateTimeFormat("en-GB", {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                }).format(new Date(roster.deputyExpiresAt))}.`
              : ""}
          </p>
        </div>
      )}

      {notice && (
        <div
          role="status"
          className="mx-4 mt-3 flex items-start gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm ring-1 ring-amber-500/30 dark:bg-amber-950/40"
        >
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="inline-flex min-h-11 items-center px-1 text-slate-500 dark:text-slate-400">
            Dismiss
          </button>
        </div>
      )}

      <Controls
        isPrimary={roster.role === "primary"}
        sessions={roster.sessions}
        enrollmentOpen={roster.enrollmentOpen}
        today={roster.today}
        session={session}
        live={live}
        busy={busy}
        selectedId={selectedId}
        onSelect={(id) => {
          setSelectedId(id);
          setReasonFor(null);
        }}
        onStart={startSession}
        onShowQr={() => setShowQr(true)}
        onSetOpen={setSessionOpen}
        onToggleEnrollment={toggleEnrollment}
      />

      {!session && (
        <p className="px-4 pt-4 text-sm text-slate-500 dark:text-slate-400">
          Start a session to take attendance. The roster below is read-only
          until you do.
        </p>
      )}

      <ul className="mt-3 divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        {roster.students.map((s) => {
          const marked = Boolean(s.markedAt);
          const showChips = reasonFor?.studentId === s.studentId;
          return (
            <li key={s.studentId}>
              <div className="flex items-stretch">
                {/* The whole row is the control. No modal, no confirm — undo is another tap. */}
                <button
                  onClick={() => toggle(s)}
                  disabled={!session}
                  aria-pressed={marked}
                  className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-3 text-left enabled:active:bg-slate-100 sm:gap-3 sm:px-4 dark:enabled:active:bg-slate-800"
                >
                  <span
                    aria-hidden
                    className={`w-4 shrink-0 text-center ${
                      marked
                        ? "text-emerald-700 dark:text-emerald-400"
                        : "text-slate-500 dark:text-slate-400"
                    }`}
                  >
                    {marked ? (s.source === "manual" ? "✎" : "✓") : "·"}
                  </span>
                  <span className="w-24 shrink-0 font-mono text-xs text-slate-500 dark:text-slate-400">
                    {s.rollNo}
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
                    <span className="truncate">{s.name}</span>
                    {s.isSelf && (
                      <span className="shrink-0 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-slate-600 dark:bg-slate-700 dark:text-slate-200">
                        YOU
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                    {marked
                      ? s.source === "manual"
                        ? "manual"
                        : formatTime(s.markedAt as string)
                      : "—"}
                  </span>
                </button>
                <button
                  onClick={() =>
                    setMenuFor(menuFor === s.studentId ? null : s.studentId)
                  }
                  aria-label={`More actions for ${s.name}`}
                  className="tap-square shrink-0 px-3 text-slate-500 dark:text-slate-400"
                >
                  ⋯
                </button>
              </div>

              {showChips && (
                <div className="flex flex-wrap items-center gap-2 px-4 pb-3 pl-11">
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {reasonFor.marked ? "Marked" : "Unmarked"} — reason
                    (optional)
                  </span>
                  {REASONS.map((r) => (
                    <button
                      key={r}
                      onClick={() => {
                        void toggleReason(s, r);
                      }}
                      className="min-h-11 rounded-full bg-slate-100 px-3.5 text-xs dark:bg-slate-800"
                    >
                      {r}
                    </button>
                  ))}
                  <button
                    onClick={() => setReasonFor(null)}
                    aria-label="Dismiss reason chips"
                    className="tap-square px-1 text-xs text-slate-500 dark:text-slate-400"
                  >
                    ✕
                  </button>
                </div>
              )}

              {menuFor === s.studentId && (
                <div className="flex flex-wrap items-center gap-3 bg-slate-50 px-4 py-3 pl-11 text-sm dark:bg-slate-900">
                  <span className="inline-flex min-h-11 items-center px-1 text-slate-500 dark:text-slate-400">
                    {s.enrolled ? "Phone registered" : "No phone registered"}
                  </span>
                  <button
                    onClick={() => void resetDevice(s)}
                    disabled={busy || !s.enrolled}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 disabled:opacity-40 dark:border-slate-700"
                  >
                    Reset device
                  </button>
                  <button
                    onClick={() => setMenuFor(null)}
                    className="inline-flex min-h-11 items-center px-1 text-slate-500 dark:text-slate-400"
                  >
                    Close
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <p className="px-4 py-4 text-xs text-slate-500 dark:text-slate-400">
        ✓ scanned · ✎ marked by hand · · absent
      </p>
    </main>
  );

  /**
   * A reason chip annotates the tap that just happened. The attendance state is
   * already correct, so this only fills in the audit entry — it must never move
   * the row.
   */
  async function toggleReason(student: Student, reason: string) {
    setReasonFor(null);
    if (!session) return;
    const res = await fetch("/api/annotate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentId: student.studentId,
        sessionId: session.id,
        reason,
      }),
    });
    if (!res.ok)
      setNotice("Saved the change, but could not record the reason.");
  }
}
