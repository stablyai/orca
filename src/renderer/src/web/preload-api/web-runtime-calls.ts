import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getClientForEnvironment,
  manuallyDisconnectedEnvironmentIds,
  manuallyDisconnectedResponse,
  requireActiveEnvironment,
  resolveEnvironment,
  runtimeCallQueuePool,
  updateEnvironmentFromResponse
} from './web-runtime-session'
import { RUNTIME_CONNECTION_CHANGED_MESSAGE } from '../web-runtime-request-registry'

export type WebRuntimeResultCaller = <TResult>(
  method: string,
  params?: unknown,
  timeoutMs?: number
) => Promise<TResult>

export type WebRuntimeEnvelopeCaller = <TResult>(
  method: string,
  params?: unknown,
  timeoutMs?: number
) => Promise<RuntimeRpcResponse<TResult>>

export async function callRuntimeEnvelope<TResult = unknown>(
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<RuntimeRpcResponse<TResult>> {
  const environment = requireActiveEnvironment()
  if (manuallyDisconnectedEnvironmentIds.has(environment.id)) {
    return manuallyDisconnectedResponse(environment)
  }
  const response = await runtimeCallQueuePool.enqueue(environment.id, method, () => {
    if (manuallyDisconnectedEnvironmentIds.has(environment.id)) {
      return Promise.resolve(manuallyDisconnectedResponse(environment))
    }
    return getClientForEnvironment(environment).call(method, params, { timeoutMs })
  })
  if (manuallyDisconnectedEnvironmentIds.has(environment.id)) {
    return manuallyDisconnectedResponse(environment)
  }
  updateEnvironmentFromResponse(environment, response)
  return response as RuntimeRpcResponse<TResult>
}

export function assertEnvironmentPairing(selector: string, expectedRevision?: number): void {
  const current = resolveEnvironment(selector)
  if (
    expectedRevision !== undefined &&
    (current.pairingRevision ?? current.createdAt) !== expectedRevision
  ) {
    throw new Error('The paired Orca server changed while the request was in progress.')
  }
}

/** Per client (epochs restart with each client): the connection whose runtime last answered a status probe. */
const probedConnections = new WeakMap<object, { epoch: number; runtimeId: string }>()

function responseRuntimeId(response: unknown): string | undefined {
  if (typeof response !== 'object' || response === null || !('_meta' in response)) {
    return undefined
  }
  const meta: unknown = response._meta
  return typeof meta === 'object' && meta !== null && 'runtimeId' in meta
    ? typeof meta.runtimeId === 'string'
      ? meta.runtimeId
      : undefined
    : undefined
}

type RuntimeClient = ReturnType<typeof getClientForEnvironment>

async function probeRuntimeStatus(
  client: RuntimeClient,
  params: unknown,
  timeoutMs: number | undefined
): Promise<RuntimeRpcResponse<unknown>> {
  const epoch = client.connectionEpoch
  const response = await client.call('status.get', params, { timeoutMs })
  const runtimeId = responseRuntimeId(response)
  if (response.ok && runtimeId && client.connectionEpoch === epoch) {
    probedConnections.set(client, { epoch, runtimeId })
  }
  return response
}

/**
 * Why: a request shaped for one runtime's capabilities must reach that runtime. The same client
 * reconnects internally, so pin it to the connection a matching status probe ran on. Probes that
 * bypass this wrapper (the status owner's) leave no proof, so a missing or stale one is re-probed.
 */
async function callPinnedToRuntime(
  client: RuntimeClient,
  method: string,
  params: unknown,
  timeoutMs: number | undefined,
  expectedEnvironmentRuntimeId: string | undefined
): Promise<RuntimeRpcResponse<unknown>> {
  if (method === 'status.get') {
    return probeRuntimeStatus(client, params, timeoutMs)
  }
  if (expectedEnvironmentRuntimeId === undefined) {
    return client.call(method, params, { timeoutMs })
  }
  if (probedConnections.get(client)?.epoch !== client.connectionEpoch) {
    await probeRuntimeStatus(client, undefined, timeoutMs)
  }
  const probed = probedConnections.get(client)
  if (probed?.runtimeId !== expectedEnvironmentRuntimeId) {
    throw new Error(RUNTIME_CONNECTION_CHANGED_MESSAGE)
  }
  return client.call(method, params, { timeoutMs, expectedConnectionEpoch: probed.epoch })
}

export async function callEnvironmentEnvelope<TResult = unknown>(
  selector: string,
  method: string,
  params?: unknown,
  timeoutMs?: number,
  expectedEnvironmentPairingRevision?: number,
  expectedEnvironmentRuntimeId?: string
): Promise<RuntimeRpcResponse<TResult>> {
  const environment = resolveEnvironment(selector)
  const assertPairing = () => assertEnvironmentPairing(selector, expectedEnvironmentPairingRevision)
  assertPairing()
  if (manuallyDisconnectedEnvironmentIds.has(environment.id)) {
    return manuallyDisconnectedResponse(environment)
  }
  const response = await runtimeCallQueuePool.enqueue(environment.id, method, () => {
    assertPairing()
    if (manuallyDisconnectedEnvironmentIds.has(environment.id)) {
      return Promise.resolve(manuallyDisconnectedResponse(environment))
    }
    return callPinnedToRuntime(
      getClientForEnvironment(environment),
      method,
      params,
      timeoutMs,
      expectedEnvironmentRuntimeId
    )
  })
  if (manuallyDisconnectedEnvironmentIds.has(environment.id)) {
    return manuallyDisconnectedResponse(environment)
  }
  assertPairing()
  updateEnvironmentFromResponse(environment, response)
  return response as RuntimeRpcResponse<TResult>
}

export async function callRuntimeResult<TResult>(
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<TResult> {
  const response = await callRuntimeEnvelope(method, params, timeoutMs)
  if (!response.ok) {
    // Why keep the code: callers classify recoverable host failures by token, and the message alone
    // (e.g. "Parent selector was not found.") carries none.
    throw Object.assign(new Error(response.error.message), { code: response.error.code })
  }
  return response.result as TResult
}

export async function callRuntimeResultWithOwner<TResult>(
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<{ result: TResult; hostId: ExecutionHostId; environmentId: string }> {
  const environmentId = requireActiveEnvironment().id
  const result = await callRuntimeResult<TResult>(method, params, timeoutMs)
  return { result, hostId: toRuntimeExecutionHostId(environmentId), environmentId }
}

export function withRuntimeRepoOwner(repo: Repo, hostId: ExecutionHostId): Repo {
  return { ...repo, executionHostId: hostId }
}

export function withRuntimeRepoMutationOwner(
  result: { repo: Repo } | { error: string },
  hostId: ExecutionHostId
): { repo: Repo } | { error: string } {
  return 'repo' in result ? { ...result, repo: withRuntimeRepoOwner(result.repo, hostId) } : result
}

export function withRuntimeWorktreeOwner<T extends Worktree>(
  worktree: T,
  hostId: ExecutionHostId
): T {
  const runtimeOwner = parseExecutionHostId(hostId)
  if (runtimeOwner?.kind !== 'runtime') {
    return worktree
  }
  return { ...worktree, runtimeOwnerEnvironmentId: runtimeOwner.environmentId }
}

export async function getRemoteRuntimeStatus(): Promise<RuntimeStatus> {
  return callRuntimeResult<RuntimeStatus>('status.get', undefined, 15_000)
}
