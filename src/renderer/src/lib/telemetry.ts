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

export function track<N extends EventName>(name: N, props: EventProps<N>): void {
  // Why: telemetry must never throw into the renderer. A missing bridge
  // (tests, early init, sandboxed iframe) would turn `window.api.telemetryTrack`
  // into a synchronous TypeError that defeats the documented fire-and-forget
  // contract. Swallow both the sync throw and any promise rejection.
  try {
    void window.api?.telemetryTrack?.(name, props as Record<string, unknown>)?.catch(() => {})
  } catch {
    // Swallow — telemetry must never break the renderer.
  }
}

export function setOptIn(optedIn: boolean): void {
  try {
    void window.api?.telemetrySetOptIn?.(optedIn)?.catch(() => {})
  } catch {
    // Swallow — telemetry must never break the renderer.
  }
}
