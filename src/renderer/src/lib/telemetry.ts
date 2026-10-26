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
  void trackWithResult(name, props)
}

// Undefined supports older bridges; false lets visible-use observations retry a rejected attempt.
export function trackWithResult<N extends EventName>(
  name: N,
  props: EventProps<N>
): Promise<boolean | void> {
  // Telemetry must never throw into renderer callers; log IPC failure for breadcrumbs instead of rethrowing or silently swallowing.
  try {
    return (
      window.api?.telemetryTrack?.(name, { ...props })?.catch((err) => {
        console.warn('[telemetry] IPC track failed', err)
        return false
      }) ?? Promise.resolve(false)
    )
  } catch (err) {
    console.warn('[telemetry] IPC track threw synchronously', err)
    return Promise.resolve(false)
  }
}

/** Resolve without rejecting so callers can order settings writes after opt-in telemetry. */
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

/** Banner dismissal persists silent opt-in, never telemetry_opted_in. Resolve without rejecting so subsequent settings fetch waits for persistence. */
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
