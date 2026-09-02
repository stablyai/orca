// Typed renderer-side wrapper around the preload bridge: gives call sites EventMap type safety, while main stays the single validator.
// Security invariant: the renderer bundles no PostHog SDK — the sole client lives in main, off the renderer's attack surface.

import type { EventName, EventProps } from '../../../shared/telemetry-events'
import type { TelemetryConsentState } from '../../../shared/telemetry-consent-types'

// Re-exported so renderer call sites can import the mapper alongside `track` (impl is shared because main needs the same mapping).
export { tuiAgentToAgentKind } from '../../../shared/agent-kind'

// Single source-of-truth for the privacy doc URL so FirstLaunchBanner and PrivacyPane can't drift.
export const PRIVACY_URL = 'https://www.onorca.dev/docs/telemetry'

// Why: the IPC boundary is untyped at runtime, so validate before the Privacy pane trusts a payload from main.
function isTelemetryConsentState(x: unknown): x is TelemetryConsentState {
  if (!x || typeof x !== 'object') {
    return false
  }
  const e = (x as { effective?: unknown }).effective
  if (e === 'enabled' || e === 'pending_banner') {
    return true
  }
  if (e === 'disabled') {
    const r = (x as { reason?: unknown }).reason
    return r === 'do_not_track' || r === 'orca_disabled' || r === 'ci' || r === 'user_opt_out'
  }
  return false
}

export function track<N extends EventName>(name: N, props: EventProps<N>): void {
  // Why: telemetry is fire-and-forget and must never throw into the renderer; log (don't rethrow/silently swallow) so IPC failures leave a breadcrumb.
  try {
    void window.api?.telemetryTrack?.(name, props as Record<string, unknown>)?.catch((err) => {
      console.warn('[telemetry] IPC track failed', err)
    })
  } catch (err) {
    console.warn('[telemetry] IPC track threw synchronously', err)
  }
}

// Returns a Promise (resolves, never rejects) so callers can await ordering a settings write after the opt-in event.
export function setOptIn(optedIn: boolean): Promise<void> {
  try {
    return (
      window.api?.telemetrySetOptIn?.(optedIn)?.catch((err) => {
        console.warn('[telemetry] IPC setOptIn failed', err)
      }) ?? Promise.resolve()
    )
  } catch (err) {
    console.warn('[telemetry] IPC setOptIn threw synchronously', err)
    return Promise.resolve()
  }
}

// Fails closed to `pending_banner` when the bridge is missing, so the UI never shows a live toggle we can't confirm.
export async function getConsentState(): Promise<TelemetryConsentState> {
  try {
    const result = await window.api?.telemetryGetConsentState?.()
    return isTelemetryConsentState(result) ? result : { effective: 'pending_banner' }
  } catch (err) {
    console.warn('[telemetry] IPC getConsentState failed', err)
    return { effective: 'pending_banner' }
  }
}

// Banner ✕ = silent persisted opt-in: unlike setOptIn(true) it must NOT emit telemetry_opted_in (user declined to intervene, didn't opt in).
// Returns a Promise (resolves, never rejects) so callers can await ordering a settings fetch after the acknowledge persists.
export function acknowledgeBanner(): Promise<void> {
  try {
    return (
      window.api?.telemetryAcknowledgeBanner?.()?.catch((err) => {
        console.warn('[telemetry] IPC acknowledgeBanner failed', err)
      }) ?? Promise.resolve()
    )
  } catch (err) {
    console.warn('[telemetry] IPC acknowledgeBanner threw synchronously', err)
    return Promise.resolve()
  }
}
