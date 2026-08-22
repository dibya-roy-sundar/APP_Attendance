"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";

/**
 * Marking present, on a passkey.
 *
 * The previous version of this screen is kept at
 * docs/superseded/ScanClient.device-binding.tsx. It identified a student by a
 * random UUID in localStorage, which Safari deletes after about a week idle, and
 * which an installed home-screen web app cannot see because iOS gives it a
 * separate storage container. See README for the whole history.
 *
 * Two things have to be true to be marked present, and neither substitutes for
 * the other: a passkey signature says *who*, and the rotating token in the QR
 * says *where*. Nothing is stored in this browser that could stand in for
 * either.
 *
 * One deliberate friction: WebAuthn cannot run without a user gesture, and
 * offers no way to ask whether a passkey exists. So this screen shows a button
 * rather than marking on load, and a failed sign-in is how we learn the phone
 * has no passkey yet.
 */

type Result =
  | { kind: "ready" }
  | { kind: "working" }
  | { kind: "marked"; name: string; classDate: string }
  | { kind: "register"; prompt: string | null }
  | { kind: "expired" }
  | { kind: "offline" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

const MESSAGES: Record<string, string> = {
  BAD_TOKEN: "That code has expired. Scan the QR on screen again.",
  SESSION_CLOSED: "Attendance is closed for this class.",
  MISSING_SESSION: "That link is incomplete. Scan the QR code again.",
  UNKNOWN_ROLL: "No student with that roll number. Check it and try again.",
  CHALLENGE_EXPIRED: "That took too long. Tap to try again.",
  BAD_ASSERTION: "Your phone could not confirm that. Try again.",
  BAD_ATTESTATION: "Your phone could not create a passkey. Try again.",
  UNKNOWN_PASSKEY:
    "This passkey is not registered here any more. Enter your roll number to set it up again.",
  PASSKEY_ALREADY_REGISTERED:
    "That passkey is already registered. Just tap “Mark me present”.",
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
  const [result, setResult] = useState<Result>({ kind: "ready" });
  const [rollNo, setRollNo] = useState("");
  const busy = useRef(false);

  const passkeysAvailable = () =>
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function";

  const post = useCallback(
    async (path: string, body: object) => {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ s: sessionId, t: token, ...body }),
      });
      return { ok: res.ok, data: await res.json().catch(() => ({})) };
    },
    [sessionId, token],
  );

  /** Tapped "Mark me present": authenticate with whatever passkey this phone holds. */
  async function markPresent() {
    if (busy.current) return;
    if (!passkeysAvailable()) return setResult({ kind: "unsupported" });
    busy.current = true;
    setResult({ kind: "working" });
    try {
      const opts = await post("/api/passkey/auth/options", {});
      if (!opts.ok) {
        setResult(
          opts.data.error === "BAD_TOKEN" ||
            opts.data.error === "SESSION_CLOSED"
            ? { kind: "expired" }
            : {
                kind: "error",
                message: MESSAGES[opts.data.error] ?? "Something went wrong.",
              },
        );
        return;
      }

      let assertion;
      try {
        assertion = await startAuthentication({
          optionsJSON: opts.data.options,
        });
      } catch {
        // Cancelled, or there is no passkey for this site on this phone. The
        // two are indistinguishable by design — WebAuthn will not tell a page
        // whether a credential exists — so offer registration and let the
        // student decide.
        setResult({
          kind: "register",
          prompt:
            "If you have not set this phone up yet, enter your roll number once.",
        });
        return;
      }

      const done = await post("/api/passkey/auth/verify", {
        response: assertion,
        challenge: opts.data.options.challenge,
      });
      if (done.ok) {
        setResult({
          kind: "marked",
          name: done.data.name,
          classDate: done.data.classDate,
        });
      } else if (done.data.error === "UNKNOWN_PASSKEY") {
        setResult({ kind: "register", prompt: MESSAGES.UNKNOWN_PASSKEY });
      } else if (
        done.data.error === "BAD_TOKEN" ||
        done.data.error === "SESSION_CLOSED"
      ) {
        setResult({ kind: "expired" });
      } else {
        setResult({
          kind: "error",
          message: MESSAGES[done.data.error] ?? "Something went wrong.",
        });
      }
    } catch {
      setResult({ kind: "offline" });
    } finally {
      busy.current = false;
    }
  }

  /** First time on this phone: claim a roll number and create the passkey. */
  async function register(e: React.FormEvent) {
    e.preventDefault();
    if (busy.current || !rollNo.trim()) return;
    if (!passkeysAvailable()) return setResult({ kind: "unsupported" });
    busy.current = true;
    setResult({ kind: "working" });
    try {
      const opts = await post("/api/passkey/register/options", {
        rollNo: rollNo.trim(),
      });
      if (!opts.ok) {
        setResult(
          opts.data.error === "BAD_TOKEN" ||
            opts.data.error === "SESSION_CLOSED"
            ? { kind: "expired" }
            : {
                kind: "register",
                prompt: MESSAGES[opts.data.error] ?? "Could not set that up.",
              },
        );
        return;
      }

      let attestation;
      try {
        attestation = await startRegistration({
          optionsJSON: opts.data.options,
        });
      } catch {
        setResult({
          kind: "register",
          prompt:
            "Your phone did not finish creating the passkey. Tap to try again.",
        });
        return;
      }

      const done = await post("/api/passkey/register/verify", {
        response: attestation,
        challenge: opts.data.options.challenge,
      });
      if (done.ok) {
        setRollNo("");
        setResult({
          kind: "marked",
          name: done.data.name,
          classDate: done.data.classDate,
        });
      } else {
        setResult({
          kind: "register",
          prompt: MESSAGES[done.data.error] ?? "Could not set that up.",
        });
      }
    } catch {
      setResult({ kind: "offline" });
    } finally {
      busy.current = false;
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center p-6">
      {(result.kind === "ready" || result.kind === "working") && (
        <Card>
          <h1 className="text-xl font-semibold">Mark your attendance</h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Confirm with Face ID or your fingerprint. Nothing to type.
          </p>
          <button
            type="button"
            onClick={markPresent}
            disabled={result.kind === "working"}
            className="mt-5 min-h-11 w-full rounded-xl bg-slate-900 px-4 py-3 text-base font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
          >
            {result.kind === "working" ? "Confirming…" : "Mark me present"}
          </button>
          <HomeLink />
        </Card>
      )}

      {result.kind === "marked" && (
        <Card tone="ok">
          <p className="text-4xl" aria-hidden>
            ✓
          </p>
          <h1 className="mt-2 text-xl font-semibold">Present</h1>
          <p className="mt-1 text-base">{result.name}</p>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {formatDate(result.classDate)}
          </p>
          <div className="mt-5">
            <Link
              href="/me"
              className="inline-flex min-h-11 items-center px-2 text-sm underline"
            >
              See my full attendance
            </Link>
          </div>
        </Card>
      )}

      {result.kind === "register" && (
        <Card>
          <h1 className="text-xl font-semibold">Set up this phone</h1>
          {result.prompt && (
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              {result.prompt}
            </p>
          )}
          <form onSubmit={register} className="mt-5 flex flex-col gap-3">
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
            <button
              type="submit"
              disabled={!rollNo.trim()}
              className="min-h-11 rounded-xl bg-slate-900 px-4 py-3 font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
            >
              Create passkey and mark present
            </button>
          </form>
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            You only do this once per phone. After that, marking present is one
            tap.
          </p>
          <button
            type="button"
            onClick={markPresent}
            className="mt-3 inline-flex min-h-11 items-center px-2 text-sm underline"
          >
            Already set up — try again
          </button>
          <HomeLink />
        </Card>
      )}

      {result.kind === "unsupported" && (
        <Card tone="warn">
          <h1 className="text-xl font-semibold">This phone cannot do passkeys</h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Attendance needs iOS 16 or later, or Android 9 or later. Ask the
            admin to mark you present by hand today.
          </p>
          <HomeLink />
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
            type="button"
            onClick={markPresent}
            className="mt-4 min-h-11 rounded-xl border border-slate-300 px-4 dark:border-slate-700"
          >
            Try again
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
          <button
            type="button"
            onClick={markPresent}
            className="mt-4 min-h-11 rounded-xl border border-slate-300 px-4 dark:border-slate-700"
          >
            Try again
          </button>
          <HomeLink />
        </Card>
      )}
    </main>
  );
}

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
