import { sendSharedControlRequest } from './remote-runtime-shared-control-connection-actions'
import type { RuntimeRequestGuard } from '../../runtime-rpc-envelope'
import type { PairedRuntimeConnection } from '../pairing/paired-runtime-connection'
import { requestSharedControl } from '../requests/remote-runtime-shared-control-requests'
import { startSharedControlSubscription } from '../requests/remote-runtime-shared-control-subscription-start'
import { sendSharedControlSubscription } from './remote-runtime-shared-control-send'
import type { SharedControlRetiredRequestIds } from '../requests/remote-runtime-shared-control-retired-request-ids'
import type * as SharedControlTypes from './remote-runtime-shared-control-types'

export class SharedControlRequests {
  constructor(
    private readonly host: {
      connection: () => PairedRuntimeConnection
      pendingRequests: Map<string, SharedControlTypes.SharedControlPendingRequest<unknown>>
      subscriptions: Map<string, SharedControlTypes.SharedControlLogicalSubscription<unknown>>
      retiredRequestIds: SharedControlRetiredRequestIds
      ensureReady: (timeoutMs: number, signal?: AbortSignal) => Promise<void>
      sendEncrypted: (payload: unknown) => boolean
      wire: () => Pick<Parameters<typeof sendSharedControlRequest>[0], 'state' | 'ws' | 'handshake'>
      closeSubscription: (requestId: string) => void
      captureSendGuard: () => () => void
    }
  ) {}
  request<TResult>(
    method: string,
    params: unknown,
    timeoutMs: number,
    envelope?: Parameters<typeof requestSharedControl>[0]['envelope'],
    signal?: AbortSignal,
    send?: Pick<Parameters<typeof requestSharedControl>[0], 'beforeSend' | 'prepareRequest'> & {
      prepareGuard?: RuntimeRequestGuard
    }
  ): ReturnType<typeof requestSharedControl<TResult>> {
    return requestSharedControl<TResult>({
      ...send,
      prepareGuard: send?.prepareGuard
        ? () => send.prepareGuard!(this.host.connection())
        : undefined,
      captureSendGuard: () => this.host.captureSendGuard(),
      pendingRequests: this.host.pendingRequests,
      deviceToken: this.host.connection().credential.deviceToken,
      method,
      params,
      timeoutMs,
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
    signal?: AbortSignal
  ): Promise<SharedControlTypes.RemoteRuntimeSharedSubscription> {
    return startSharedControlSubscription({
      subscriptions: this.host.subscriptions,
      deviceToken: this.host.connection().credential.deviceToken,
      method,
      params,
      callbacks,
      signal,
      ensureReady: () => this.host.ensureReady(timeoutMs, signal),
      sendSubscription: (subscription) =>
        sendSharedControlSubscription({
          subscriptions: this.host.subscriptions,
          subscription,
          deviceToken: this.host.connection().credential.deviceToken,
          send: (payload) => this.host.sendEncrypted(payload)
        }),
      closeSubscription: (requestId) => this.host.closeSubscription(requestId)
    })
  }
}
