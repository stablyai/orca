// The card and the Webhooks row read and change hooks only through the bot's execution host.
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  WEBHOOK_ERROR_CODES,
  type WebhookCallRow,
  type WebhookCardParams,
  type WebhookCallsParams,
  type WebhookDeleteParams,
  type WebhookKey,
  type WebhookPauseParams,
  type WebhookRevealParams,
  type WebhookRotateParams,
  type WebhookSampleParams,
  type WebhookSecretParams,
  type WebhooksListParams,
  type WebhookSummary
} from '../../../../../shared/rpc-contract/webhooks-params'

type WebhookMethods = {
  'webhooks.card': [WebhookCardParams, WebhookSummary]
  'webhooks.list': [WebhooksListParams, { hooks: WebhookSummary[] }]
  'webhooks.calls': [WebhookCallsParams, { calls: WebhookCallRow[] }]
  'webhooks.reveal': [WebhookRevealParams, WebhookKey]
  'webhooks.rotate': [WebhookRotateParams, { cancelledCalls: number }]
  'webhooks.secret': [WebhookSecretParams, { secret?: string }]
  'webhooks.sample': [WebhookSampleParams, { callId: string }]
  'webhooks.pause': [WebhookPauseParams, { paused: boolean; pending: boolean }]
  'webhooks.delete': [WebhookDeleteParams, { removed: boolean; pending: boolean }]
}

export type WebhookMethod = keyof WebhookMethods

type Transport = <M extends WebhookMethod>(
  target: RuntimeClientTarget,
  method: M,
  params: WebhookMethods[M][0]
) => Promise<WebhookMethods[M][1]>

const runtimeTransport: Transport = (target, method, params) =>
  callRuntimeRpc(target, method, params)

let transport: Transport = runtimeTransport

export function callWebhookHost<M extends WebhookMethod>(
  target: RuntimeClientTarget,
  method: M,
  params: WebhookMethods[M][0]
): Promise<WebhookMethods[M][1]> {
  return transport(target, method, params)
}

/** Tests and fixture screenshots answer in place of the host; null restores it. */
export function setWebhookHostTransportForTests(next: Transport | null): void {
  transport = next ?? runtimeTransport
}

export type WebhookErrorCode = (typeof WEBHOOK_ERROR_CODES)[number] | 'failed'

/** Why a webhooks.* call failed, in the host's codes; a host without the methods needs an update. */
export function webhookErrorCode(error: unknown): WebhookErrorCode {
  if (!(error instanceof RuntimeRpcCallError)) {
    return 'failed'
  }
  if (error.code === 'method_not_found') {
    return 'host_needs_update'
  }
  return WEBHOOK_ERROR_CODES.find((code) => code === error.code) ?? 'failed'
}

/** One id per owner click, so a retried rotate or secret change isn't applied twice. */
export function newWebhookOperationId(): string {
  return createBrowserUuid()
}
