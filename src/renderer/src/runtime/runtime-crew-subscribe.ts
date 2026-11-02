import type {
  CrewSetupFact,
  CrewSubscriptionAttemptArgs,
  CrewSubscriptionAttemptCallbacks
} from '../../../shared/runtime-environment-subscription-setup'
import { observePairingRefusal } from './runtime-environment-pairing-refresh'
import { createBrowserUuid } from '../lib/browser-uuid'

export class RuntimeCrewSetupError extends Error {
  constructor(
    message: string,
    readonly fact: CrewSetupFact,
    readonly code?: string
  ) {
    super(message)
    this.name = 'RuntimeCrewSetupError'
  }
}

/** Capture before invoking: cancellation and a late result always address the same principal. */
export function createRuntimeCrewSubscriptionAttempt(
  source: Omit<CrewSubscriptionAttemptArgs, 'subscriptionId' | 'method' | 'timeoutMs'>,
  callbacks: CrewSubscriptionAttemptCallbacks
): {
  subscriptionId: string
  start: () => Promise<{ unsubscribe: () => void }>
  cancel: () => void
} {
  const args: CrewSubscriptionAttemptArgs = {
    ...source,
    subscriptionId: `crew-${createBrowserUuid()}`,
    method: 'orchestration.crewSubscribe',
    timeoutMs: 15_000
  }
  const api = window.api.runtimeEnvironments
  let request: Promise<{ unsubscribe: () => void }> | undefined
  let started = false
  let cancelled = false
  const cancel = (): void => {
    if (cancelled) {
      return
    }
    cancelled = true
    if (started) {
      void api.cancelSubscription({ subscriptionId: args.subscriptionId })
    }
  }
  const start = (): Promise<{ unsubscribe: () => void }> => {
    if (request) {
      return request
    }
    if (cancelled) {
      request = observePairingRefusal(
        Promise.reject(new RuntimeCrewSetupError('Subscription cancelled', { kind: 'cancelled' }))
      )
      return request
    }
    const subscribe = api.subscribeCrewAttempt
    if (!subscribe) {
      request = observePairingRefusal(
        Promise.reject(
          new RuntimeCrewSetupError('Crew subscriptions are unavailable', {
            kind: 'host-unsupported'
          })
        )
      )
      return request
    }
    started = true
    let result: ReturnType<typeof subscribe>
    try {
      result = subscribe(args, {
        onResponse: (response) => {
          if (!cancelled) {
            callbacks.onResponse(response)
          }
        },
        onError: (error) => {
          if (!cancelled) {
            callbacks.onError?.(error)
          }
        },
        onClose: () => {
          if (!cancelled) {
            callbacks.onClose?.()
          }
        }
      })
    } catch (error) {
      result = Promise.reject(error)
    }
    request = observePairingRefusal(
      result.then((outcome) => {
        if (!outcome.ok) {
          throw new RuntimeCrewSetupError(
            outcome.failure.message,
            outcome.failure.fact,
            outcome.failure.code
          )
        }
        if (cancelled) {
          throw new RuntimeCrewSetupError('Subscription cancelled', { kind: 'cancelled' })
        }
        return { unsubscribe: cancel }
      })
    )
    return request
  }
  return { subscriptionId: args.subscriptionId, start, cancel }
}
