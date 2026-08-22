"use client";

import { deviceId, storagePersists } from "@/lib/device";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type Result =
  | { kind: "loading" }
  | { kind: "marked"; name: string; classDate: string }
  | { kind: "enroll"; classDate: string }
  | { kind: "expired" }
  | { kind: "offline" }
  | { kind: "error"; message: string };

/** Human wording for every server code, so nobody ever sees a raw error string. */
const MESSAGES: Record<string, string> = {
  BAD_TOKEN: "That code has expired. Scan the QR on screen again.",
  SESSION_CLOSED: "Attendance is closed for this class.",
  MISSING_SESSION: "That link is incomplete. Scan the QR code again.",
  BAD_DEVICE:
    "Your browser blocked local storage. Turn off private browsing and retry.",
  UNKNOWN_ROLL: "No student with that roll number. Check it and try again.",
  ALREADY_CLAIMED:
    "That roll number is already linked to a phone. If that phone is this one and it has stopped recognising you, ask the admin to reset your device.",
  DEVICE_ALREADY_BOUND:
    "This phone is already registered to a different student.",
};

function formatDate(d: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${d}T00:00:00Z`));
}

export function ScanClient({
  sessionId,
  token,
}: {
  sessionId: string;
  token: string;
}) {
  const [result, setResult] = useState<Result>({ kind: "loading" });
  const [rollNo, setRollNo] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  // A React 19 dev remount must not fire two marks for one scan.
  const started = useRef(false);
  // Probed on the client only: touching localStorage during render would differ
  // between the server pass and the browser and trip hydration.
  const [persists, setPersists] = useState(true);
  useEffect(() => {
    setPersists(storagePersists());
  }, []);

  const mark = useCallback(async () => {
    if (!sessionId || !token) {
      setResult({ kind: "error", message: MESSAGES.MISSING_SESSION });
      return;
    }
    try {
      const res = await fetch("/api/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ s: sessionId, t: token, deviceId: deviceId() }),
      });
      const body = await res.json();

      if (body.status === "MARKED") {
        setResult({
          kind: "marked",
          name: body.name,
          classDate: body.classDate,
        });
      } else if (body.status === "NEEDS_ENROLL") {
        setResult({ kind: "enroll", classDate: body.classDate });
      } else if (
        body.error === "BAD_TOKEN" ||
        body.error === "SESSION_CLOSED"
      ) {
        setResult({ kind: "expired" });
      } else {
        setResult({
          kind: "error",
          message: MESSAGES[body.error] ?? "Something went wrong. Scan again.",
        });
      }
    } catch {
      // Airplane mode mid-scan lands here — say so, never fail silently.
      setResult({ kind: "offline" });
    }
  }, [sessionId, token]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void mark();
  }, [mark]);

  async function submitEnroll(e: React.FormEvent) {
    e.preventDefault();
    if (!rollNo.trim() || enrolling) return;
    setEnrolling(true);
    setEnrollError(null);
    try {
      const res = await fetch("/api/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          s: sessionId,
          t: token,
          rollNo: rollNo.trim(),
          deviceId: deviceId(),
        }),
      });
      const body = await res.json();
      if (body.status === "ENROLLED" || body.status === "MARKED") {
        setResult({
          kind: "marked",
          name: body.name,
          classDate: body.classDate ?? new Date().toISOString().slice(0, 10),
        });
      } else if (
        body.error === "BAD_TOKEN" ||
        body.error === "SESSION_CLOSED"
      ) {
        setResult({ kind: "expired" });
      } else {
        setEnrollError(
          MESSAGES[body.error] ?? "Could not register. Try again.",
        );
      }
    } catch {
      setEnrollError("No connection. Check your signal and try again.");
    } finally {
      setEnrolling(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center p-6">
      {result.kind === "loading" && (
        <Card>
          <p className="text-slate-500 dark:text-slate-400">
            Marking you present…
          </p>
        </Card>
      )}

      {result.kind === "marked" && (
        <Card tone="ok">
          <div className="text-5xl" aria-hidden>
            ✓
          </div>
          <h1 className="mt-3 text-xl font-semibold">Present</h1>
          <p className="mt-1 text-lg">{result.name}</p>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {formatDate(result.classDate)}
          </p>
          <Link
            href="/me"
            className="mt-5 inline-flex min-h-11 items-center justify-center text-sm underline"
          >
            See my full attendance
          </Link>
        </Card>
      )}

      {result.kind === "enroll" && (
        <Card>
          <h1 className="text-xl font-semibold">One-time registration</h1>
          {persists ? (
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              Enter your roll number. It gets linked to this phone, and you will
              not need to type it again.
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                Enter your roll number to be marked present today.
              </p>
              {/* Registering still works and still counts — but this browser
                  will not keep the link, so do not promise that it will. */}
              <p
                role="alert"
                className="mt-3 rounded-xl bg-amber-50 px-3 py-2.5 text-sm ring-1 ring-amber-500/30 dark:bg-amber-950/40"
              >
                This browser is blocking site data, so the link to your phone
                will not be saved. You will be marked present today, but next
                class you will have to ask the admin to reset your phone. To
                avoid that, allow site data (or leave Private Browsing) and scan
                again.
              </p>
            </>
          )}
          <form onSubmit={submitEnroll} className="mt-5 flex flex-col gap-3">
            <input
              value={rollNo}
              onChange={(e) => setRollNo(e.target.value)}
              placeholder="MT2026002"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Roll number"
              className="rounded-xl border border-slate-300 px-4 py-3 text-lg tracking-wide dark:border-slate-700 dark:bg-slate-900"
            />
            {enrollError && (
              <p
                role="alert"
                className="text-sm text-red-600 dark:text-red-400"
              >
                {enrollError}
              </p>
            )}
            <button
              type="submit"
              disabled={enrolling || !rollNo.trim()}
              className="rounded-xl bg-slate-900 px-4 py-3 font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
            >
              {enrolling ? "Registering…" : "Register and mark present"}
            </button>
          </form>
        </Card>
      )}

      {result.kind === "expired" && (
        <Card tone="warn">
          <h1 className="text-xl font-semibold">Code expired</h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            The QR code on screen has already changed. Scan the current one.
          </p>
          <HomeLink />
        </Card>
      )}

      {result.kind === "offline" && (
        <Card tone="warn">
          <h1 className="text-xl font-semibold">No connection</h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            You were not marked present. Check your signal, then scan again.
          </p>
          <button
            onClick={() => {
              setResult({ kind: "loading" });
              void mark();
            }}
            className="mt-5 inline-flex min-h-11 items-center rounded-xl border border-slate-300 px-4 text-sm dark:border-slate-700"
          >
            Retry
          </button>
          <HomeLink />
        </Card>
      )}

      {result.kind === "error" && (
        <Card tone="warn">
          <h1 className="text-xl font-semibold">Not marked</h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            {result.message}
          </p>
          <HomeLink />
        </Card>
      )}
    </main>
  );
}

/** Installed as a PWA there is no address bar, so every card needs an exit. */
function HomeLink() {
  return (
    <div className="mt-5">
      <Link
        href="/"
        className="inline-flex min-h-11 items-center px-2 text-sm text-slate-500 underline dark:text-slate-400"
      >
        Home
      </Link>
    </div>
  );
}

function Card({
  children,
  tone = "plain",
}: {
  children: React.ReactNode;
  tone?: "plain" | "ok" | "warn";
}) {
  const ring =
    tone === "ok"
      ? "ring-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/40"
      : tone === "warn"
        ? "ring-amber-500/30 bg-amber-50 dark:bg-amber-950/40"
        : "ring-slate-900/10 bg-white dark:bg-slate-900 dark:ring-white/10";
  return (
    <div className={`rounded-2xl p-6 text-center ring-1 ${ring}`}>
      {children}
    </div>
  );
}
