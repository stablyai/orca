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

export async function callEnvironmentEnvelope<TResult = unknown>(
  selector: string,
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<RuntimeRpcResponse<TResult>> {
  const environment = resolveEnvironment(selector)
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
