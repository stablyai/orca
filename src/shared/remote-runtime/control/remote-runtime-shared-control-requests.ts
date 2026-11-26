import { sendSharedControlRequest } from './remote-runtime-shared-control-connection-actions'
import type { RuntimeRequestGuard } from '../rpc/runtime-rpc-envelope'
import type { PairedRuntimeConnection } from '../pairing/paired-runtime-connection'
import { requestSharedControl } from '../requests/remote-runtime-shared-control-requests'
import { startSharedControlSubscription } from '../requests/remote-runtime-shared-control-subscription-start'
import { sendSharedControlSubscription } from './remote-runtime-shared-control-send'
import type { SharedControlRetiredRequestIds } from '../requests/remote-runtime-shared-control-retired-request-ids'
import type * as SharedControlTypes from './remote-runtime-shared-control-types'
import type { SharedControlBinaryChannels } from './remote-runtime-shared-control-binary-channels'
import { remoteRuntimeUnavailableError } from '../requests/remote-runtime-request-frames'
import { pairedRuntimeConnectionToken } from '../pairing/paired-runtime-connection'

export class SharedControlRequests {
  constructor(
    private readonly host: {
      connection: () => PairedRuntimeConnection
      pendingRequests: Map<string, SharedControlTypes.SharedControlPendingRequest<unknown>>
      subscriptions: Map<string, SharedControlTypes.SharedControlLogicalSubscription<unknown>>
      retiredRequestIds: SharedControlRetiredRequestIds
      ensureReady: (timeoutMs: number, signal?: AbortSignal) => Promise<void>
      sendEncrypted: (payload: unknown) => boolean
      wire: () => Pick<Parameters<typeof sendSharedControlRequest>[0], 'state' | 'channel'>
      closeSubscription: (requestId: string) => void
      captureSendGuard: () => () => void
      binaryChannels: () => SharedControlBinaryChannels | null
    }
  ) {}
  request<TResult>(
    method: string,
    params: unknown,
    timeoutMs: number,
    envelope?: Parameters<typeof requestSharedControl>[0]['envelope'],
    signal?: AbortSignal,
    send?: Pick<
      Parameters<typeof requestSharedControl>[0],
      'beforeSend' | 'prepareRequest' | 'idlePassive' | 'binaryChannel'
    > & {
      prepareGuard?: RuntimeRequestGuard
      /** Bounds the whole request while socket readiness keeps timeoutMs, so an unreachable host fails fast. */
      responseTimeoutMs?: number
    }
  ): ReturnType<typeof requestSharedControl<TResult>> {
    const { responseTimeoutMs, ...sendOptions } = send ?? {}
    return requestSharedControl<TResult>({
      ...sendOptions,
      prepareGuard: send?.prepareGuard
        ? () => send.prepareGuard!(this.host.connection())
        : undefined,
      captureSendGuard: () => this.host.captureSendGuard(),
      pendingRequests: this.host.pendingRequests,
      deviceToken: pairedRuntimeConnectionToken(this.host.connection()),
      method,
      params,
      timeoutMs: responseTimeoutMs ?? timeoutMs,
      envelope,
      ensureReady: () => this.host.ensureReady(timeoutMs, signal),
      send: (requestId) =>
        sendSharedControlRequest({
          ...this.host.wire(),
          requestId,
          pendingRequests: this.host.pendingRequests
        }),
      retireRequestId: (requestId) => this.host.retiredRequestIds.retire(requestId),
      signal
    })
  }
  async subscribe<TResult>(
    method: string,
    params: unknown,
    timeoutMs: number,
    callbacks: SharedControlTypes.SharedControlSubscriptionCallbacks<TResult>,
    signal?: AbortSignal,
    /** A stream that would otherwise need a socket of its own: it gets a binary channel. */
    stream?: Pick<
      SharedControlTypes.SharedControlLogicalSubscription<unknown>,
      'channelCapabilities' | 'idlePassive'
    > & { binaryChannel: true }
  ): Promise<SharedControlTypes.RemoteRuntimeSharedSubscription> {
    const binaryChannels = stream ? this.host.binaryChannels() : null
    return startSharedControlSubscription({
      subscriptions: this.host.subscriptions,
      deviceToken: pairedRuntimeConnectionToken(this.host.connection()),
      method,
      params,
      callbacks,
      signal,
      ensureReady: () => this.host.ensureReady(timeoutMs, signal),
      sendSubscription: (subscription) =>
        sendSharedControlSubscription({
          subscriptions: this.host.subscriptions,
          subscription,
          deviceToken: pairedRuntimeConnectionToken(this.host.connection()),
          send: (payload) => this.host.sendEncrypted(payload)
        }),
      closeSubscription: (requestId) => this.host.closeSubscription(requestId),
      binaryChannel: binaryChannels
        ? {
            assign: (subscription) => binaryChannels.assign(subscription, stream!),
            sendBinary: (subscription, bytes) => binaryChannels.sendData(subscription, bytes),
            // A call on an ended stream would open its channel anew on the host; refuse it as the
            // stream's own socket did once closed.
            sendRequest: (subscription, method, params, timeoutMs) => {
              const ended = (): boolean => subscription.closed || !subscription.sent
              if (ended()) {
                return Promise.reject(remoteRuntimeUnavailableError('The stream has ended.'))
              }
              return this.request(method, params, timeoutMs, undefined, undefined, {
                binaryChannel: subscription.binaryChannel,
                beforeSend: () => {
                  if (ended()) {
                    throw remoteRuntimeUnavailableError('The stream has ended.')
                  }
                }
              })
            }
          }
        : undefined
    })
  }
}
