// Shared consent-state shape, serializable across the main/renderer IPC
// boundary. Lives in `shared/` rather than main so the Privacy pane
// (renderer-side) can import the type without pulling in main-only code.
//
// The same discriminated union is what `src/main/telemetry/consent.ts`
// produces from `resolveConsent(settings)`. Keeping it here as the source
// of truth means the IPC getter in `src/main/ipc/telemetry.ts` returns
// this exact shape and the Privacy pane renders helper text by pattern-
// matching the `reason` without re-deriving the rules.

export type TelemetryConsentState =
  | { effective: 'enabled' }
  | {
      effective: 'disabled'
      reason: 'do_not_track' | 'orca_disabled' | 'ci' | 'user_opt_out'
    }
  | { effective: 'pending_banner' }
