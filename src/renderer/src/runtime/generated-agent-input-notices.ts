import { isWebClientLocation } from '@/lib/web-client-location'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { GENERATED_INPUT_RECOVERY_RUNTIME_CAPABILITY } from '../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import { createGeneratedInputNoticeFeed } from '../../../shared/generated-input-notice-feed'
import {
  callRuntimeRpc,
  ensureRuntimeEnvironmentCompatible,
  runtimeEnvironmentSupportsCapability
} from './runtime-rpc-client'
import { subscribeRuntimeEnvironment } from './runtime-environment-pairing-refresh'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import {
  generatedInputNoticeWindow,
  noticeAudience,
  type GeneratedInputNoticeHost
} from './generated-input-notice-registration'

import {
  projectGeneratedInputNotices,
  localGeneratedInputNoticeSnapshot,
  resolveLocalGeneratedInputNoticeSnapshot
} from './generated-input-notice-toast-projection'

const SUBSCRIBE = 'terminal.generatedInputNotices.subscribe'

function feedFor(target: RuntimeClientTarget, owner?: GeneratedInputNoticeHost) {
  return createGeneratedInputNoticeFeed({
    readPage: (from) =>
      callRuntimeRpc(
        target,
        'terminal.generatedInputNotices.page',
        { ...from, ...noticeAudience(target) },
        {
          timeoutMs: 15_000,
          ...(owner
            ? {
                expectedEnvironmentRuntimeId: owner.runtimeId,
                expectedEnvironmentPairingRevision: owner.pairingRevision
              }
            : {})
        }
      ),
    ...projectGeneratedInputNotices(target, owner)
  })
}

function receive(feed: ReturnType<typeof feedFor>, response: RuntimeRpcResponse<unknown>): void {
  if (response.ok) {
    feed.receive(response.result)
  }
}

const localRecoveries = new Set<() => void>()

/** Existing online, resume and host-ready events wake only failed local work. */
export function retryLocalGeneratedInputNoticeRecovery(): void {
  for (const retry of localRecoveries) {
    retry()
  }
}

/** The local runtime is this renderer's own version, so it always speaks the notice protocol. */
/** This window's own notice stream; a paired web client reads its host's instead. */
export function subscribeWindowGeneratedInputNotices(): () => void {
  return isWebClientLocation() ? () => {} : subscribeLocalGeneratedInputNotices()
}

export function subscribeLocalGeneratedInputNotices(): () => void {
  let feed: ReturnType<typeof feedFor> | undefined
  let stopped = false
  let generation = 0
  let subscribing = false
  let failed = true
  let wake = false
  let unsubscribe: (() => void) | undefined
  if (typeof window.api?.runtime?.subscribe !== 'function') {
    resolveLocalGeneratedInputNoticeSnapshot()
    return () => {}
  }
  const connect = (): void => {
    if (stopped || subscribing) {
      return
    }
    const current = ++generation
    unsubscribe?.()
    unsubscribe = undefined
    feed?.stop()
    const activeFeed = feedFor({ kind: 'local' })
    feed = activeFeed
    subscribing = true
    failed = false
    wake = false
    void Promise.resolve()
      .then(() =>
        window.api.runtime.subscribe({ method: SUBSCRIBE }, (response) => {
          if (!stopped && current === generation) {
            if (!response.ok) {
              failed = true
            } else {
              receive(activeFeed, response)
            }
          }
        })
      )
      .then((subscription) => {
        if (stopped || current !== generation) {
          subscription?.unsubscribe()
        } else {
          unsubscribe = subscription?.unsubscribe
        }
      })
      .catch(() => {
        if (current === generation) {
          failed = true
        }
      })
      .finally(() => {
        if (current !== generation) {
          return
        }
        subscribing = false
        if (!stopped && wake) {
          if (failed) {
            connect()
          } else {
            activeFeed.retry()
          }
        }
      })
  }
  const retry = (): void => {
    if (subscribing) {
      wake = true
    } else if (failed) {
      connect()
    } else {
      feed?.retry()
    }
  }
  localRecoveries.add(retry)
  connect()
  return () => {
    stopped = true
    generation += 1
    localRecoveries.delete(retry)
    feed?.stop()
    unsubscribe?.()
  }
}

/** A paired runtime's notices, only when it advertises the bounded protocol. */
export function subscribeEnvironmentGeneratedInputNotices(environmentId: string): () => void {
  let feed: ReturnType<typeof feedFor> | undefined
  let stopped = false
  let unsubscribe: (() => void) | undefined
  void runtimeEnvironmentSupportsCapability(
    environmentId,
    GENERATED_INPUT_RECOVERY_RUNTIME_CAPABILITY
  )
    .then(async (capable) => {
      if (!capable || stopped) {
        return null
      }
      // The capability probe already established this status. Its runtime, rather than the
      // feed's session id or an environment guess, fences every page and mutation receipt.
      const pairingRevision = getRuntimeEnvironmentRevision(environmentId)
      const status = await ensureRuntimeEnvironmentCompatible(environmentId, {
        expectedEnvironmentPairingRevision: pairingRevision
      })
      if (!isWebClientLocation()) {
        await localGeneratedInputNoticeSnapshot
      }
      if (!status || stopped) {
        return null
      }
      const owner = {
        environmentId,
        window: generatedInputNoticeWindow(),
        runtimeId: status.runtimeId,
        pairingRevision
      }
      const activeFeed = feedFor({ kind: 'environment', environmentId }, owner)
      feed = activeFeed
      return subscribeRuntimeEnvironment(
        {
          selector: environmentId,
          method: SUBSCRIBE,
          params: noticeAudience({ kind: 'environment', environmentId }),
          timeoutMs: 15_000,
          expectedEnvironmentPairingRevision: pairingRevision,
          expectedEnvironmentRuntimeId: status.runtimeId
        },
        { onResponse: (response) => receive(activeFeed, response), onError: console.warn }
      )
    })
    .then((subscription) => {
      if (stopped) {
        subscription?.unsubscribe()
      } else {
        unsubscribe = subscription?.unsubscribe
      }
    })
    .catch(console.warn)
  return () => {
    stopped = true
    feed?.stop()
    unsubscribe?.()
  }
}

/** Tie a paired runtime's notice stream to its client-event subscription's lifetime. The same
 *  promise is returned, so the caller's cleanup runs on the same turn it always did. */
export function withEnvironmentGeneratedInputNotices<T extends { unsubscribe: () => void }>(
  environmentId: string,
  subscription: Promise<T>
): Promise<T> {
  const stopNotices = subscribeEnvironmentGeneratedInputNotices(environmentId)
  // Registered before the caller's own handlers, so they read the extended unsubscribe.
  subscription.then(
    (events) => {
      const unsubscribeEvents = events.unsubscribe
      events.unsubscribe = () => {
        stopNotices()
        unsubscribeEvents()
      }
    },
    () => stopNotices()
  )
  return subscription
}
