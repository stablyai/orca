import { afterEach, vi } from 'vitest'
const restoreApis: (() => void)[] = []
afterEach(() => {
  restoreApis
    .splice(0)
    .toReversed()
    .forEach((restore) => restore())
})
import {
  RuntimeAccountController,
  type RuntimeAccountServices
} from '../../../main/runtime/runtime-account-controller'
import { createEmptyRateLimitState } from '../../../shared/rate-limit-state-factory'
import type { RateLimitState } from '../../../shared/rate-limit-types'
import type { ProviderAccountsSnapshot } from './runtime-provider-accounts-client'

export function accountHost() {
  const snapshot: ProviderAccountsSnapshot = {
    claude: {
      accounts: ['a', 'b'].map((id) => ({
        id,
        email: `${id}@example.com`,
        authMethod: 'subscription-oauth',
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1,
        home: `/accounts/${id}`
      })),
      activeAccountId: 'a',
      activeAccountIdsByRuntime: { host: 'a', wsl: { Ubuntu: null, Debian: null } }
    },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: createEmptyRateLimitState()
  }
  const listeners = new Set<(state: RateLimitState) => void>()
  const claudeList = vi.fn(() => structuredClone(snapshot.claude))
  const codexList = vi.fn(() => structuredClone(snapshot.codex))
  const services = {
    claudeAccounts: { listAccounts: claudeList },
    codexAccounts: { listAccounts: codexList },
    rateLimits: {
      getState: () => snapshot.rateLimits,
      onStateChange: (listener: (state: RateLimitState) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  }
  const controller = new RuntimeAccountController()
  // SAFETY: this controller fixture exercises only getStreamSnapshot/onChanged and provides every service method those paths call.
  controller.setServices(services as RuntimeAccountServices)
  return {
    snapshot,
    controller,
    claudeList,
    codexList,
    listeners,
    emit: () => {
      for (const listener of listeners) {
        listener(snapshot.rateLimits ?? createEmptyRateLimitState())
      }
    }
  }
}

type Callbacks = {
  onResponse: (response: unknown) => void
  onError: (error: { code: string; message: string }) => void
  onClose: () => void
}
export function accountTransport(
  hosts: Record<string, ReturnType<typeof accountHost>>,
  autoReady = true
) {
  let projectionReads = 0
  const streams: {
    host: string
    callbacks: Callbacks
    close: ReturnType<typeof vi.fn>
    send: (snapshot: ProviderAccountsSnapshot) => void
  }[] = []
  const subscribe = vi.fn(async (args: { selector: string }, callbacks: Callbacks) => {
    const host = hosts[args.selector]
    if (!host) {
      throw new Error('Unknown fixture host')
    }
    const send = (snapshot: ProviderAccountsSnapshot) => {
      const copy = structuredClone(snapshot)
      const active = copy.claude.activeAccountId
      Object.defineProperty(copy.claude, 'activeAccountId', {
        enumerable: true,
        get: () => {
          projectionReads += 1
          return active
        }
      })
      callbacks.onResponse({ ok: true, result: { type: 'snapshot', snapshot: copy } })
    }
    const release = host.controller.onChanged(send)
    const close = vi.fn(release)
    streams.push({ host: args.selector, callbacks, close, send })
    if (autoReady) {
      queueMicrotask(() => send(host.controller.getStreamSnapshot()))
    }
    return { unsubscribe: close, sendBinary: () => false }
  })
  const descriptor = Object.getOwnPropertyDescriptor(window, 'api')
  const api = {
    ...window.api,
    runtimeEnvironments: { ...window.api?.runtimeEnvironments, subscribe }
  }
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  restoreApis.push(() => {
    if (descriptor) {
      Object.defineProperty(window, 'api', descriptor)
    } else {
      Reflect.deleteProperty(window, 'api')
    }
  })
  return {
    subscribe,
    streams,
    get projectionReads() {
      return projectionReads
    },
    reset: () => {
      projectionReads = 0
      for (const host of Object.values(hosts)) {
        host.claudeList.mockClear()
        host.codexList.mockClear()
      }
    }
  }
}
