import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../../../shared/protocol-version'
import {
  RuntimeEnvironmentSetupGuardError,
  runtimeEnvironmentSetupFailure,
  type CrewSetupFact,
  type CrewSubscriptionAttemptArgs,
  type CrewSubscriptionAttemptCallbacks,
  type CrewSubscriptionSetupResult,
  type RuntimeEnvironmentSetupFailure
} from '../../../../shared/runtime-environment-subscription-setup'
import type { WebRuntimeSubscriptionHandle } from '../web-runtime-client'
import type { PreloadApi } from '../../../../preload/api-types'
import { getPreferredWebRuntimeConnection } from '../web-runtime-environment'
import {
  manuallyDisconnectedEnvironmentIds,
  resolveEnvironment,
  runtimeCallQueuePool,
  updateEnvironmentFromResponse,
  webRuntimeState
} from './web-runtime-session'

export type WebRuntimeSubscriptionRegistration = {
  controller: AbortController
  handle?: WebRuntimeSubscriptionHandle
  crewAttempt?: true
}

export function createWebRuntimeSubscriptionApiControl(
  registrations: Map<string, WebRuntimeSubscriptionRegistration>
): Pick<PreloadApi['runtimeEnvironments'], 'cancelSubscription' | 'subscribeCrewAttempt'> {
  return {
    cancelSubscription: async ({ subscriptionId }) => {
      const record = registrations.get(subscriptionId)
      if (record?.crewAttempt) {
        registrations.delete(subscriptionId)
      }
      record?.controller.abort()
      record?.handle?.unsubscribe()
    },
    subscribeCrewAttempt: (args, callbacks) =>
      subscribeWebRuntimeCrewAttempt(registrations, args, callbacks)
  }
}

/** Uses the API's existing registration owner for both pending and retained finite attempts. */
export async function subscribeWebRuntimeCrewAttempt(
  registrations: Map<string, WebRuntimeSubscriptionRegistration>,
  args: CrewSubscriptionAttemptArgs,
  callbacks: CrewSubscriptionAttemptCallbacks
): Promise<CrewSubscriptionSetupResult> {
  const record: WebRuntimeSubscriptionRegistration = {
    controller: new AbortController(),
    crewAttempt: true
  }
  let terminal = false
  let observedFailure: RuntimeEnvironmentSetupFailure | undefined
  const release = (): void => {
    terminal = true
    if (registrations.get(args.subscriptionId) === record) {
      registrations.delete(args.subscriptionId)
    }
  }
  const refuse = (message: string, fact: CrewSetupFact): never => {
    throw new RuntimeEnvironmentSetupGuardError(message, fact)
  }
  try {
    if (
      !args.subscriptionId ||
      args.method !== 'orchestration.crewSubscribe' ||
      !Number.isFinite(args.expectedEnvironmentPairingRevision) ||
      !(
        args.expectedEnvironmentRuntimeId === null ||
        typeof args.expectedEnvironmentRuntimeId === 'string'
      )
    ) {
      refuse('Invalid crew subscription', { kind: 'input' })
    }
    if (registrations.has(args.subscriptionId)) {
      refuse('Subscription id already exists', { kind: 'input' })
    }
    registrations.set(args.subscriptionId, record)
    const environment = resolveEnvironment(args.selector)
    const assertCurrent = (): void => {
      if (record.controller.signal.aborted) {
        throw record.controller.signal.reason
      }
      if (manuallyDisconnectedEnvironmentIds.has(environment.id)) {
        refuse('runtime_manually_disconnected', { kind: 'manual-disconnect' })
      }
      const active = webRuntimeState.activeEnvironment
      if (
        active?.id !== environment.id ||
        (active.pairingRevision ?? active.createdAt) !== args.expectedEnvironmentPairingRevision ||
        active.runtimeId !== args.expectedEnvironmentRuntimeId ||
        getPreferredWebRuntimeConnection(active).hostPublicKeyB64 !==
          getPreferredWebRuntimeConnection(environment).hostPublicKeyB64
      ) {
        refuse('The paired Orca server changed while the request was in progress.', {
          kind: 'source-retired'
        })
      }
    }
    assertCurrent()
    const client = webRuntimeState.activeClient
    const epoch = client?.connectionEpoch
    const assertVerified = (): void => {
      const snapshot = client?.statusOwner?.read()
      if (
        snapshot?.status &&
        !snapshot.status.capabilities?.includes(REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY)
      ) {
        refuse('Shared control is unavailable on this server', { kind: 'host-unsupported' })
      }
      if (
        !client ||
        webRuntimeState.activeClientEnvironmentId !== environment.id ||
        args.expectedEnvironmentRuntimeId === null ||
        !snapshot ||
        snapshot.retired ||
        snapshot.verification !== 'verified' ||
        snapshot.transport !== 'ready' ||
        snapshot.pairingRevision !== args.expectedEnvironmentPairingRevision ||
        snapshot.status?.runtimeId !== args.expectedEnvironmentRuntimeId ||
        client.connectionEpoch !== epoch
      ) {
        refuse('The verified runtime session is unavailable', { kind: 'source-retired' })
      }
    }
    assertVerified()
    if (!client) {
      return refuse('The verified runtime session is unavailable', { kind: 'source-retired' })
    }
    const assertClient = (): void => {
      assertCurrent()
      assertVerified()
      if (webRuntimeState.activeClient !== client) {
        refuse('The paired Orca server changed while the request was in progress.', {
          kind: 'source-retired'
        })
      }
    }
    const outcome = await runtimeCallQueuePool.enqueue(
      environment.id,
      args.method,
      () => {
        assertClient()
        return client.subscribeCrewAttempt(
          args.params,
          {
            onResponse: (response) => {
              try {
                assertClient()
                if (
                  response._meta?.runtimeId != null &&
                  response._meta.runtimeId !== args.expectedEnvironmentRuntimeId
                ) {
                  refuse('Runtime environment identity changed; refresh and try again', {
                    kind: 'source-retired'
                  })
                }
              } catch (error) {
                release()
                record.controller.abort(error)
                callbacks.onClose?.()
                return
              }
              updateEnvironmentFromResponse(environment, response)
              callbacks.onResponse(response)
              if (!response.ok) {
                release()
              }
            },
            onError: (error) => {
              release()
              callbacks.onError?.(error)
            },
            onClose: () => {
              release()
              callbacks.onClose?.()
            }
          },
          {
            timeoutMs: args.timeoutMs,
            signal: record.controller.signal,
            assertCurrent: assertClient
          }
        )
      },
      0,
      record.controller.signal
    )
    if (outcome.ok) {
      record.handle = outcome.value
    }
    assertClient()
    if (!outcome.ok) {
      observedFailure = outcome.failure
      throw outcome.failure.error
    }
    if (terminal) {
      outcome.value.unsubscribe()
    }
    return { subscriptionId: args.subscriptionId, ok: true }
  } catch (error) {
    const failure = record.controller.signal.aborted
      ? record.controller.signal.reason instanceof RuntimeEnvironmentSetupGuardError
        ? runtimeEnvironmentSetupFailure(record.controller.signal.reason, 'subscription')
        : { error: record.controller.signal.reason, fact: { kind: 'cancelled' as const } }
      : (observedFailure ?? runtimeEnvironmentSetupFailure(error, 'subscription'))
    release()
    record.controller.abort()
    record.handle?.unsubscribe()
    return {
      subscriptionId: args.subscriptionId,
      ok: false,
      failure: {
        message: failure.error instanceof Error ? failure.error.message : String(failure.error),
        ...(typeof failure.error === 'object' &&
        failure.error !== null &&
        'code' in failure.error &&
        typeof failure.error.code === 'string'
          ? { code: failure.error.code }
          : {}),
        fact: failure.fact
      }
    }
  }
}
