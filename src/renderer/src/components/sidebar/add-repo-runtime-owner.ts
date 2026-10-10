import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { getActiveRuntimeTarget, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

export type CapturedRuntimeOwner = string | null | undefined

export function capturedAddRepoExecutionHostId(
  owner: CapturedRuntimeOwner,
  sshConnectionId?: string | null
): ExecutionHostId | undefined {
  return sshConnectionId
    ? toSshExecutionHostId(sshConnectionId)
    : owner !== undefined
      ? owner
        ? toRuntimeExecutionHostId(owner)
        : LOCAL_EXECUTION_HOST_ID
      : undefined
}

export function worktreeRefreshOptions(
  owner: CapturedRuntimeOwner,
  sshConnectionId?: string | null
): {
  requireAuthoritative: true
  executionHostId?: ExecutionHostId
} {
  const executionHostId = capturedAddRepoExecutionHostId(owner, sshConnectionId)
  return {
    requireAuthoritative: true,
    ...(executionHostId ? { executionHostId } : {})
  }
}

export function resolveAddRepoRuntimeTarget(
  runtimeEnvironmentId: string | null | undefined,
  settings: Parameters<typeof getActiveRuntimeTarget>[0]
): RuntimeClientTarget {
  const environmentId = runtimeEnvironmentId?.trim()
  return environmentId
    ? { kind: 'environment', environmentId }
    : getActiveRuntimeTarget({ ...settings, activeRuntimeEnvironmentId: null })
}
