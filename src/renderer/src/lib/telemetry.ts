// Typed renderer-side wrapper around the preload bridge.
//
// Renderer call sites import `track` from this module rather than reaching
// for `window.api.telemetryTrack` directly, because this wrapper is what
// gives them the `EventMap`-based type safety. The preload bridge is
// deliberately typed as a loose `(name: string, props: Record<string,
// unknown>) => Promise<void>` so it can cross the IPC boundary without
// pretending the renderer's types are load-bearing — the main-side
// validator is the single enforcement point (see
// `docs/telemetry-implementation.md` §"IPC surface").
//
// The renderer does NOT bundle `posthog-node` or any PostHog SDK. There is
// one PostHog client in the process tree and it lives in main. That
// invariant is what keeps the vendor out of the renderer's attack surface.

import type { EventName, EventProps } from '../../../shared/telemetry-events'

export function track<N extends EventName>(name: N, props: EventProps<N>): void {
  // Fire-and-forget: the renderer does not await the main-side capture.
  // `void` suppresses the float-promise lint without changing semantics.
  void window.api.telemetryTrack(name, props as Record<string, unknown>)
}

export function setOptIn(optedIn: boolean): void {
  void window.api.telemetrySetOptIn(optedIn)
}
