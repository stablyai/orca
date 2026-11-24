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

/** The one host incarnation a caller confirmed: its pairing and runtime, and whether both still hold. */
export type WebhookHostBinding = {
  pairingRevision: number
  runtimeId: string
  current: () => boolean
}

/** A hook's host. With `binding`, every call goes only to that incarnation and a reply that lands
 *  after it changed is refused, so controls confirmed against one host never act on another. */
export type WebhookHostTarget =
  | { kind: 'local' }
  | { kind: 'environment'; environmentId: string; binding?: WebhookHostBinding }

type Transport = <M extends WebhookMethod>(
  target: RuntimeClientTarget,
  method: M,
  params: WebhookMethods[M][0],
  binding?: Pick<WebhookHostBinding, 'pairingRevision' | 'runtimeId'>
) => Promise<WebhookMethods[M][1]>

const runtimeTransport: Transport = (target, method, params, binding) =>
  callRuntimeRpc(
    target,
    method,
    params,
    binding
      ? {
          expectedEnvironmentPairingRevision: binding.pairingRevision,
          expectedEnvironmentRuntimeId: binding.runtimeId
        }
      : {}
  )

let transport: Transport = runtimeTransport

/** The bound host changed before or while a call was in flight; the reply, if any, is not used. */
export class WebhookHostChangedError extends Error {
  constructor() {
    super('The chat’s host changed. Reopen the chat to set up this webhook.')
    this.name = 'WebhookHostChangedError'
  }
}

export async function callWebhookHost<M extends WebhookMethod>(
  target: WebhookHostTarget,
  method: M,
  params: WebhookMethods[M][0]
): Promise<WebhookMethods[M][1]> {
  if (target.kind === 'local' || !target.binding) {
    return await transport(hostOnly(target), method, params)
  }
  const { binding } = target
  if (!binding.current()) {
    throw new WebhookHostChangedError()
  }
  const result = await transport(hostOnly(target), method, params, {
    pairingRevision: binding.pairingRevision,
    runtimeId: binding.runtimeId
  })
  if (!binding.current()) {
    throw new WebhookHostChangedError()
  }
  return result
}

function hostOnly(target: WebhookHostTarget): RuntimeClientTarget {
  return target.kind === 'local'
    ? target
    : { kind: 'environment', environmentId: target.environmentId }
}

/** A cache key for the host: a bound target's reads are its own incarnation's, never shared. */
export function webhookHostKey(target: WebhookHostTarget): string {
  if (target.kind === 'local') {
    return 'local'
  }
  const { binding } = target
  return binding
    ? `env:${target.environmentId}@${binding.pairingRevision}:${binding.runtimeId}`
    : `env:${target.environmentId}`
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
