import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../../../shared/concurrency/abort-signal-reason'

import {
  type RuntimeEnvironmentSetupFailure,
  runtimeEnvironmentSetupFailure
} from '../../../../../shared/remote-runtime/host-catalog/runtime-environment-subscription-setup'
import type { WebRuntimeClient } from './web-runtime-client'
import type {
  WebRuntimeTransportSubscription,
  WebRuntimeSubscriptionCallbacks,
  WebRuntimeTransportSubscriptionHandle,
  WebRuntimeSubscribeOptions
} from './web-runtime-subscription-contract'

export type WebRuntimeCrewSetupOutcome<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; failure: RuntimeEnvironmentSetupFailure }>

export async function subscribeDedicatedWebRuntime({
  createClient,
  children,
  subscribe,
  getSetupFailure,
  callbacks,
  options,
  observeFailure
}: {
  createClient: () => WebRuntimeClient
  children: Set<WebRuntimeClient>
  subscribe: (
    client: WebRuntimeClient,
    callbacks: WebRuntimeSubscriptionCallbacks
  ) => Promise<WebRuntimeTransportSubscriptionHandle>
  getSetupFailure: (client: WebRuntimeClient) => RuntimeEnvironmentSetupFailure | undefined
  callbacks: WebRuntimeSubscriptionCallbacks
  options?: WebRuntimeSubscribeOptions
  observeFailure?: (failure: RuntimeEnvironmentSetupFailure) => void
}): Promise<WebRuntimeTransportSubscriptionHandle> {
  const client = createClient()
  children.add(client)
  const closeChild = (notifySubscriptions = false): void => {
    options?.signal?.removeEventListener('abort', onAbort)
    children.delete(client)
    client.close({ notifySubscriptions })
  }
  const onAbort = (): void => closeChild()
  try {
    const wrappedCallbacks: WebRuntimeSubscriptionCallbacks = {
      ...callbacks,
      onResponse: (response) => {
        callbacks.onResponse(response)
        if (observeFailure && !response.ok) {
          closeChild()
        }
      },
      onError: (error) => {
        callbacks.onError?.(error)
        closeChild()
      },
      onClose: () => {
        callbacks.onClose?.()
        closeChild()
      }
    }
    const pending = subscribe(client, wrappedCallbacks)
    options?.signal?.addEventListener('abort', onAbort, { once: true })
    if (options?.signal?.aborted) {
      onAbort()
    }
    const handle = await pending
    return {
      unsubscribe: () => {
        options?.signal?.removeEventListener('abort', onAbort)
        handle.unsubscribe()
        closeChild()
      },
      sendBinary: (bytes) => handle.sendBinary(bytes)
    }
  } catch (error) {
    observeFailure?.(
      getSetupFailure(client) ?? runtimeEnvironmentSetupFailure(error, 'subscription')
    )
    options?.signal?.removeEventListener('abort', onAbort)
    closeChild()
    throw error
  }
}

export async function observeCrewSubscriptionSetup(
  subscribe: (
    observe: (failure: RuntimeEnvironmentSetupFailure) => void
  ) => Promise<WebRuntimeTransportSubscriptionHandle>
): Promise<WebRuntimeCrewSetupOutcome<WebRuntimeTransportSubscriptionHandle>> {
  let failure: RuntimeEnvironmentSetupFailure | undefined
  try {
    const value = await subscribe((observed) => {
      failure = observed
    })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, failure: failure ?? runtimeEnvironmentSetupFailure(error, 'subscription') }
  }
}

export async function enrollWebRuntimeSubscription({
  method,
  params,
  callbacks,
  options,
  waitForConnected,
  nextId,
  subscriptions,
  sendEncrypted,
  sendBinary,
  deviceToken
}: {
  method: string
  params: unknown
  callbacks: WebRuntimeSubscriptionCallbacks
  options?: WebRuntimeSubscribeOptions
  waitForConnected: (timeoutMs?: number, signal?: AbortSignal) => Promise<void>
  nextId: () => string
  subscriptions: Map<string, WebRuntimeTransportSubscription>
  sendEncrypted: (message: unknown) => boolean
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean
  deviceToken: string
}): Promise<WebRuntimeTransportSubscriptionHandle> {
  // The outer wait keeps main's normalized abort reason; the inner signal frees the waiter early.
  await waitForPromiseWithSignal(
    waitForConnected(options?.timeoutMs, options?.signal),
    options?.signal
  )
  throwIfSignalAborted(options?.signal)
  options?.assertCurrent?.()
  const id = nextId()
  const subscription = { id, method, params, callbacks, needsReplay: false }
  subscriptions.set(id, subscription)
  if (
    !sendEncrypted({
      id,
      deviceToken: deviceToken,
      method,
      params
    })
  ) {
    subscriptions.delete(id)
    throw new Error('Remote Orca runtime is not connected.')
  }
  return {
    unsubscribe: () => {
      subscriptions.delete(subscription.id)
      const teardown = options?.buildUnsubscribe?.(params, subscription.id)
      if (teardown) {
        sendEncrypted({
          id: nextId(),
          deviceToken: deviceToken,
          method: teardown.method,
          params: teardown.params
        })
      }
    },
    sendBinary: (bytes) => {
      sendBinary(bytes)
    }
  }
}
