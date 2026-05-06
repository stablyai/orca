// Typed renderer-side wrapper around the preload bridge.
//
// Renderer call sites import `track` from this module rather than reaching
// for `window.api.telemetryTrack` directly, because this wrapper is what
// gives them the `EventMap`-based type safety. The preload bridge is
// deliberately typed as a loose `(name: string, props: Record<string,
// unknown>) => Promise<void>` so it can cross the IPC boundary without
// pretending the renderer's types are load-bearing — the main-side
// validator is the single enforcement point.
//
// The renderer does NOT bundle `posthog-node` or any PostHog SDK. There is
// one PostHog client in the process tree and it lives in main. That
// invariant is what keeps the vendor out of the renderer's attack surface.

import type { EventName, EventProps } from '../../../shared/telemetry-events'
import type { TelemetryConsentState } from '../../../shared/telemetry-consent-types'

// Re-exported so renderer call sites can import the mapper from this lib
// alongside `track`. The implementation lives in `src/shared/agent-kind.ts`
// because main-process telemetry emission needs the same mapping when it
// receives a `TuiAgent`-derived agent kind through the spawn IPC.
export { tuiAgentToAgentKind } from '../../../shared/agent-kind'

// Why: single source-of-truth for the privacy doc URL linked from the two
// telemetry surfaces (FirstLaunchBanner, PrivacyPane). Keeping it here — in
// the shared telemetry lib — prevents the surfaces from drifting if the doc
// ever moves.
export const PRIVACY_URL = 'https://www.onorca.dev/docs/telemetry'

// Why: the IPC boundary is untyped at runtime, so a malformed payload from
// main would otherwise let the Privacy pane render on garbage. Validate the
// `effective` discriminant (and `reason` when disabled) before trusting it;
// fall through to `pending_banner` otherwise, matching the bridge-missing
// fail-closed behavior below.
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
  // Why: telemetry must never throw into the renderer. A missing bridge
  // (tests, early init, sandboxed iframe) would turn `window.api.telemetryTrack`
  // into a synchronous TypeError that defeats the documented fire-and-forget
  // contract. Log (do not rethrow) on both the sync throw and any promise
  // rejection so IPC failures leave a diagnostic breadcrumb while preserving
  // the fire-and-forget contract — silent swallowing would let disk state
  // drift out of sync with UI state with zero signal to anyone debugging.
  try {
    void window.api?.telemetryTrack?.(name, props as Record<string, unknown>)?.catch((err) => {
      console.warn('[telemetry] IPC track failed', err)
    })
  } catch (err) {
    console.warn('[telemetry] IPC track threw synchronously', err)
  }
}

// Returns a Promise so callers that need to order a subsequent settings
// write after the opt-in event can `await` it. Most call sites ignore the
// return value; the fire-and-forget contract is preserved by resolving
// (not rejecting) on any bridge error.
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

// Read the effective consent state for Privacy-pane rendering. Fails
// closed to `pending_banner` if the bridge is missing (tests, sandbox),
// which the UI treats like a non-actionable/disabled toggle — safer than
// pretending the toggle is live when we cannot confirm consent.
export async function getConsentState(): Promise<TelemetryConsentState> {
  try {
    const result = await window.api?.telemetryGetConsentState?.()
    return isTelemetryConsentState(result) ? result : { effective: 'pending_banner' }
  } catch (err) {
    console.warn('[telemetry] IPC getConsentState failed', err)
    return { effective: 'pending_banner' }
  }
}

// Banner ✕ — silent persisted opt-IN (acknowledge without eventing).
// Separate channel from `setOptIn(true)` because the event contract for
// the ✕ path is "persist optedIn=true, fire nothing." Routing this through
// `setOptIn(true)` would derive `via='first_launch_banner'` and emit
// `telemetry_opted_in`, which the ✕-as-silent-acknowledge semantics
// forbid — the user did not explicitly opt in, they declined to intervene.
// The only renderer surface that calls this bridge is the FirstLaunchBanner
// ✕ button; the banner's "Turn off" and every other opt-{in,out} path
// uses `setOptIn(…)` so the corresponding event still fires.
//
// Returns a Promise so callers that need to order a subsequent settings
// fetch after main has persisted the acknowledge can `await` it. Most
// call sites ignore the return value; the fire-and-forget contract is
// preserved by resolving (not rejecting) on any bridge error.
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
