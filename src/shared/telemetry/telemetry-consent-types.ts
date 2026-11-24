// Share resolveConsent’s IPC union with the Privacy pane so renderer text matches reason codes without importing main or re-deriving consent.

export type TelemetryConsentState =
  | { effective: 'enabled' }
  | {
      effective: 'disabled'
      reason: 'do_not_track' | 'orca_disabled' | 'ci' | 'user_opt_out'
    }
  | { effective: 'pending_banner' }
