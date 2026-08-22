# Superseded implementations

Nothing in this folder runs. It is excluded from `tsconfig.json` and from
eslint, and it references modules that no longer exist. It is kept so that the
reasoning behind the current design is recoverable, and so nobody re-proposes
an approach that was already tried and failed for a concrete reason.

The full narrative is in the root [README](../../README.md), under **Why
identity moved from localStorage, to a cookie, to passkeys**. This is the file
list.

| File | Was | Why it went |
|---|---|---|
| `ScanClient.device-binding.tsx` | The student's scan screen | Identified a student by a UUID in `localStorage`, which Safari deletes after ~7 days idle and which an installed iOS web app cannot see |
| `api-mark.device-binding.ts` | `POST /api/mark` | Looked a student up by device id; that mapping is gone |
| `api-enroll.device-binding.ts` | `POST /api/enroll` | Claimed a roll number for a device id |
| `api-me.device-binding.ts` | `POST /api/me` | Took a device id in the request body |
| `api-reset-device.ts` | `POST /api/reset-device` | Existed only because a student who lost their `localStorage` could not recover without an admin. A passkey recovers itself |
| `api-claim-device.ts` | `POST /api/admin/claim-device` | Let the admin bind their own phone without scanning, since they cannot scan a QR their own screen is showing. Under passkeys they register like any student |
| `lib-device.ts` | `deviceId()`, `storagePersists()` | Generated and stored the UUID |
| `lib-device-cookie.ts` | The durable second copy | An httpOnly cookie mirroring the UUID. It solved Safari's purge but not the iOS storage-container split, and was still a bearer token anyone could copy |
| `AdminClient.with-device-reset.tsx` | Admin grid | Contained "Reset device" and "Register this phone", both meaningless now |

Two smaller pieces are commented out **in place**, because they sit inside files
that are still live and the comment is more useful next to the code that
replaced it:

- `getStudentByDevice()` in `src/lib/data.ts`
- `normaliseDeviceId()` in `src/lib/api.ts`
