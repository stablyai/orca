import {
  acquireNativeChatSessionOptionLease,
  type NativeChatSessionOptionLease
} from './native-chat-session-option-cache'
import {
  enrichNativeChatSessionOptionBinding,
  nativeChatSessionOptionBindingObservationsEqual,
  sameNativeChatSessionOptionBinding,
  type NativeChatSessionOptionBinding
} from './native-chat-session-option-binding'

export type NativeChatSessionOptionBindingSource = {
  getBindingSnapshot: () => NativeChatSessionOptionBinding
  isHeld: () => boolean
  subscribeBinding: (listener: () => void) => () => void
}

export type NativeChatSessionOptionOwner = {
  readonly binding: NativeChatSessionOptionBinding
  readCurrentBinding: () => NativeChatSessionOptionBinding | null
  captureBinding: (known: NativeChatSessionOptionBinding) => NativeChatSessionOptionBinding | null
  currentBinding: () => NativeChatSessionOptionBinding | null
  getSnapshot: () => NativeChatSessionOptionBinding
  subscribe: (listener: () => void) => () => void
  attach: (source: NativeChatSessionOptionBindingSource) => () => void
}

export function createNativeChatSessionOptionOwner(
  binding: NativeChatSessionOptionBinding,
  readCurrentBinding: () => NativeChatSessionOptionBinding | null
): NativeChatSessionOptionOwner {
  let captured = { ...binding }
  const listeners = new Set<() => void>()
  const sources = new Set<NativeChatSessionOptionBindingSource>()
  const captureBinding = (
    known: NativeChatSessionOptionBinding
  ): NativeChatSessionOptionBinding | null => {
    if (!sameNativeChatSessionOptionBinding(captured, known)) {
      return null
    }
    const next = enrichNativeChatSessionOptionBinding(captured, known)
    if (!nativeChatSessionOptionBindingObservationsEqual(captured, next)) {
      captured = next
      for (const listener of listeners) {
        listener()
      }
    }
    return captured
  }
  return {
    binding: { ...binding },
    readCurrentBinding,
    captureBinding,
    getSnapshot: () => captured,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    attach: (source) => {
      sources.add(source)
      const observe = (): void => {
        if (source.isHeld()) {
          captureBinding(source.getBindingSnapshot())
        }
      }
      observe()
      const unsubscribe = source.subscribeBinding(observe)
      observe()
      return () => {
        unsubscribe()
        sources.delete(source)
      }
    },
    currentBinding: () => {
      for (const source of sources) {
        if (!source.isHeld() || !captureBinding(source.getBindingSnapshot())) {
          return null
        }
      }
      const current = readCurrentBinding()
      return current ? captureBinding(current) : null
    }
  }
}

export function acquireNativeChatSessionOptionOwnerLease(
  scopeKey: string,
  owner: NativeChatSessionOptionOwner | undefined,
  fallbackScopeKey?: string
): NativeChatSessionOptionLease | null {
  const held = owner ? acquireNativeChatSessionOptionLease(scopeKey, owner, fallbackScopeKey) : null
  if (!held || !owner) {
    return null
  }
  const detach = owner.attach(held)
  return {
    ...held,
    release: () => {
      detach()
      held.release()
    }
  }
}

export function settleNativeChatSessionOptionLease<T>(
  held: NativeChatSessionOptionLease | null,
  mutate: () => T
): T | undefined {
  let result: T | undefined
  held?.settle(() => {
    result = mutate()
    return true
  })
  return result
}
