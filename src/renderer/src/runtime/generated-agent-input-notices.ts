import { toast } from 'sonner'
import type { GeneratedAgentInputNotice } from '../../../shared/generated-agent-input-notice'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { GENERATED_INPUT_RECOVERY_RUNTIME_CAPABILITY } from '../../../shared/terminal-runtime-capabilities'
import {
  createGeneratedInputNoticeFeed,
  type GeneratedInputNoticeDelta
} from '../../../shared/generated-input-notice-feed'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { subscribeRuntimeEnvironment } from './runtime-environment-pairing-refresh'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { showGeneratedInputNotice } from '@/lib/launch-agent-paste-timeout-notice'

const SUBSCRIBE = 'terminal.generatedInputNotices.subscribe'

// Shown toasts belong to the runtime environment, not to one subscription: a replaced or replayed
// subscription reconciles the same toasts once its snapshot is complete instead of stranding them.
const shownByEnvironment = new Map<string, Map<string, string>>()

/** Project one runtime's notices as persistent toasts; that runtime owns them and their dismissal. */
function projectNotices(target: RuntimeClientTarget) {
  const environment = target.kind === 'local' ? 'local' : target.environmentId
  const shown = shownByEnvironment.get(environment) ?? new Map<string, string>()
  shownByEnvironment.set(environment, shown)
  const show = (notice: GeneratedAgentInputNotice, toastId: string): void => {
    showGeneratedInputNotice({
      ...notice,
      id: toastId,
      onDismiss: () => {
        if (!shown.has(notice.id)) {
          return
        }
        void callRuntimeRpc(target, 'terminal.dismissGeneratedInputNotice', {
          id: notice.id
        }).catch(() => {
          // Failed dismissal is not permission to discard the canonical notice.
          if (shown.has(notice.id)) {
            show(notice, toastId)
          }
        })
      }
    })
  }
  const add = (notice: GeneratedAgentInputNotice, session: string): void => {
    if (!shown.has(notice.id)) {
      const toastId = `generated-input:${environment}:${session}:${notice.id}`
      shown.set(notice.id, toastId)
      show(notice, toastId)
    }
  }
  const remove = (id: string): void => {
    const toastId = shown.get(id)
    if (toastId !== undefined) {
      shown.delete(id)
      toast.dismiss(toastId)
    }
  }
  return {
    // A (re)subscription's complete view: one pass over what is shown and what is wanted.
    onSnapshot: (notices: GeneratedAgentInputNotice[], session: string): void => {
      const wanted = new Map(notices.map((notice) => [notice.id, notice]))
      for (const [id, toastId] of shown) {
        if (!wanted.has(id) || !toastId.endsWith(`:${session}:${id}`)) {
          remove(id)
        }
      }
      for (const notice of notices) {
        add(notice, session)
      }
    },
    // A live change touches only its own toast.
    onDelta: (delta: GeneratedInputNoticeDelta, session: string): void =>
      delta.kind === 'added' ? add(delta.notice, session) : remove(delta.id)
  }
}

function feedFor(target: RuntimeClientTarget) {
  return createGeneratedInputNoticeFeed({
    readPage: (from) =>
      callRuntimeRpc(target, 'terminal.generatedInputNotices.page', from ?? {}, {
        timeoutMs: 15_000
      }),
    ...projectNotices(target)
  })
}

function receive(feed: ReturnType<typeof feedFor>, response: RuntimeRpcResponse<unknown>): void {
  if (response.ok) {
    feed.receive(response.result)
  }
}

/** The local runtime is this renderer's own version, so it always speaks the notice protocol. */
export function subscribeLocalGeneratedInputNotices(): () => void {
  const feed = feedFor({ kind: 'local' })
  let stopped = false
  let unsubscribe: (() => void) | undefined
  // A preload without runtime subscriptions has no local notices to show.
  if (typeof window.api?.runtime?.subscribe !== 'function') {
    return () => {}
  }
  void Promise.resolve(
    window.api.runtime.subscribe({ method: SUBSCRIBE }, (response) => receive(feed, response))
  )
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
    feed.stop()
    unsubscribe?.()
  }
}

/** A paired runtime's notices, only when it advertises the bounded protocol. */
export function subscribeEnvironmentGeneratedInputNotices(environmentId: string): () => void {
  const feed = feedFor({ kind: 'environment', environmentId })
  let stopped = false
  let unsubscribe: (() => void) | undefined
  void runtimeEnvironmentSupportsCapability(
    environmentId,
    GENERATED_INPUT_RECOVERY_RUNTIME_CAPABILITY
  )
    .then((capable) =>
      capable && !stopped
        ? subscribeRuntimeEnvironment(
            {
              selector: environmentId,
              method: SUBSCRIBE,
              timeoutMs: 15_000,
              expectedEnvironmentPairingRevision: getRuntimeEnvironmentRevision(environmentId)
            },
            { onResponse: (response) => receive(feed, response), onError: console.warn }
          )
        : null
    )
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
    feed.stop()
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
