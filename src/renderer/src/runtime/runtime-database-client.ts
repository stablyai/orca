import type {
  DatabaseConnectionRequest,
  DatabaseConnectionTestResult,
  DatabaseProviderId,
  DatabaseQueryRequest,
  DatabaseQueryResult,
  DatabaseSchemaResult
} from '../../../shared/database-types'
import { DATABASE_QUERY_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  getRuntimeEnvironmentIdForWorktree,
  getSshConnectionIdForWorktree
} from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  getActiveRuntimeTarget,
  type RuntimeClientTarget
} from './runtime-rpc-client'

function getDatabaseTarget(worktreeId: string): RuntimeClientTarget {
  const state = useAppStore.getState()
  return getActiveRuntimeTarget({
    activeRuntimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  })
}

function withProjectExecution<TRequest extends DatabaseConnectionRequest>(
  worktreeId: string,
  request: TRequest
): TRequest {
  const sshConnectionId = getSshConnectionIdForWorktree(useAppStore.getState(), worktreeId)
  if (!sshConnectionId) {
    return request
  }
  return {
    ...request,
    execution: { kind: 'ssh', connectionId: sshConnectionId }
  }
}

async function callDatabaseRuntimeRpc<TResult>(
  worktreeId: string,
  method: string,
  params: unknown,
  timeoutMs: number
): Promise<TResult> {
  const target = getDatabaseTarget(worktreeId)
  if (target.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      DATABASE_QUERY_RUNTIME_CAPABILITY,
      'Database Query requires a newer Orca runtime on the project host.',
      timeoutMs
    )
  }
  return callRuntimeRpc<TResult>(target, method, params, { timeoutMs })
}

export function testDatabaseConnection(
  worktreeId: string,
  request: DatabaseConnectionRequest
): Promise<DatabaseConnectionTestResult> {
  return callDatabaseRuntimeRpc(
    worktreeId,
    'database.testConnection',
    withProjectExecution(worktreeId, request),
    35_000
  )
}

export function introspectDatabase(
  worktreeId: string,
  request: DatabaseConnectionRequest
): Promise<DatabaseSchemaResult> {
  return callDatabaseRuntimeRpc(
    worktreeId,
    'database.introspect',
    withProjectExecution(worktreeId, request),
    35_000
  )
}

export function executeDatabaseQuery(
  worktreeId: string,
  request: DatabaseQueryRequest
): Promise<DatabaseQueryResult> {
  return callDatabaseRuntimeRpc(
    worktreeId,
    'database.execute',
    withProjectExecution(worktreeId, request),
    request.timeoutMs + 10_000
  )
}

export async function cancelDatabaseQuery(
  worktreeId: string,
  providerId: DatabaseProviderId,
  queryId: string
): Promise<boolean> {
  const result = await callDatabaseRuntimeRpc<{ canceled: boolean }>(
    worktreeId,
    'database.cancel',
    { providerId, queryId },
    5_000
  )
  return result.canceled
}
