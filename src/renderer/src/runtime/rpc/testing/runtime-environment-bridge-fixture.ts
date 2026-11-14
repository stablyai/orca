import { vi } from 'vitest'
import type { Mock } from 'vitest'

type RuntimeEnvironmentsBridge = Window['api']['runtimeEnvironments']

/** The preload methods a test drives; anything left out is absent, as on an older preload. */
export type RuntimeEnvironmentBridgeStub = { [Method in keyof RuntimeEnvironmentsBridge]?: unknown }

/** Frames stay `unknown` so tests can feed malformed or envelope-less responses to decoders. */
export type RecordedRuntimeSubscriptionCallbacks = {
  onResponse: (response: unknown) => void
  onBinary?: (bytes: Uint8Array) => void
  onError?: (error: { code: string; message: string }) => void
  onClose?: () => void
}

/** Replaces `window` with one that exposes only the given runtime-environment bridge methods. */
export function stubRuntimeEnvironmentBridge(bridge: RuntimeEnvironmentBridgeStub): void {
  vi.stubGlobal('window', { api: { runtimeEnvironments: bridge } })
}

/** Every web browser create asks main for its placement, so a `call`-only bridge fails the create. */
export function stubBrowserCreateRuntimeEnvironmentBridge(
  call: unknown,
  prepareBrowserClientHostPlacement: unknown = vi.fn().mockResolvedValue({ kind: 'server' })
): void {
  stubRuntimeEnvironmentBridge({ call, prepareBrowserClientHostPlacement })
}

export type RuntimeSubscriptionRecorder = {
  subscribe: Mock<
    (args: unknown, callbacks: RecordedRuntimeSubscriptionCallbacks) => Promise<unknown>
  >
  unsubscribe: Mock<() => void>
  /** Callbacks of the most recent subscribe; throws when nothing subscribed yet. */
  callbacks: () => RecordedRuntimeSubscriptionCallbacks
  /** Delivers one response frame to the most recent subscriber. */
  respond: (response: unknown) => void
}

/** A `subscribe` stub that resolves a live handle and keeps the latest subscriber's callbacks. */
export function recordRuntimeSubscription(
  handle: Record<string, unknown> = {}
): RuntimeSubscriptionRecorder {
  const unsubscribe = vi.fn<() => void>()
  let latest: RecordedRuntimeSubscriptionCallbacks | undefined
  const subscribe = vi.fn(async (_args: unknown, next: RecordedRuntimeSubscriptionCallbacks) => {
    latest = next
    return { unsubscribe, sendBinary: vi.fn(), ...handle }
  })
  const callbacks = (): RecordedRuntimeSubscriptionCallbacks => {
    if (!latest) {
      throw new Error('Expected subscription callbacks')
    }
    return latest
  }
  return {
    subscribe,
    unsubscribe,
    callbacks,
    respond: (response) => callbacks().onResponse(response)
  }
}
