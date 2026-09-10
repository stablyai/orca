import type {
  DatabaseCatalogResult,
  DatabaseConnectionRequest,
  DatabaseConnectionTestResult,
  DatabaseNodeRequest,
  DatabaseProfileDeleteRequest,
  DatabaseProfileListResult,
  DatabaseProfileSaveRequest,
  DatabaseProfileSummary,
  DatabaseProviderId,
  DatabaseQueryRequest,
  DatabaseQueryResult,
  DatabaseSchemaResult
} from '../../../shared/database-types'
import {
  DATABASE_PROFILE_RUNTIME_CAPABILITY,
  DATABASE_QUERY_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import {
  getRuntimeEnvironmentIdForWorktree,
  getSshConnectionIdForWorktree
} from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  resolveActiveWorkspaceRoute,
  resolveWorktreeOperationRouteResult
} from '@/lib/worktree-operation-route'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  getActiveRuntimeTarget,
  type RuntimeClientTarget
} from './runtime-rpc-client'

function getDatabaseTarget(worktreeId: string): RuntimeClientTarget {
  const state = useAppStore.getState()
  if (
    worktreeId !== FLOATING_TERMINAL_WORKTREE_ID &&
    !resolveActiveWorkspaceRoute(state, worktreeId) &&
    resolveWorktreeOperationRouteResult(state, worktreeId).kind !== 'resolved'
  ) {
    throw new Error('The database project host is unavailable or ambiguous.')
  }
  return getActiveRuntimeTarget({
    activeRuntimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  })
}

function withProjectExecution<TRequest extends DatabaseNodeRequest>(
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
  timeoutMs: number,
  capability: string = DATABASE_QUERY_RUNTIME_CAPABILITY,
  target: RuntimeClientTarget = getDatabaseTarget(worktreeId)
): Promise<TResult> {
  if (target.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      capability,
      'Database features require a newer Orca runtime on the project host.',
      timeoutMs
    )
  }
  return callRuntimeRpc<TResult>(target, method, params, { timeoutMs })
}

export function listDatabaseProfiles(worktreeId: string): Promise<DatabaseProfileListResult> {
  return callDatabaseRuntimeRpc(
    worktreeId,
    'database.profiles.list',
    withProjectExecution(worktreeId, {}),
    10_000,
    DATABASE_PROFILE_RUNTIME_CAPABILITY
  )
}

export function saveDatabaseProfile(
  worktreeId: string,
  request: DatabaseProfileSaveRequest
): Promise<DatabaseProfileSummary> {
  return callDatabaseRuntimeRpc(
    worktreeId,
    'database.profiles.save',
    withProjectExecution(worktreeId, request),
    10_000,
    DATABASE_PROFILE_RUNTIME_CAPABILITY
  )
}

export async function deleteDatabaseProfile(
  worktreeId: string,
  request: DatabaseProfileDeleteRequest
): Promise<boolean> {
  const result = await callDatabaseRuntimeRpc<{ deleted: boolean }>(
    worktreeId,
    'database.profiles.delete',
    withProjectExecution(worktreeId, request),
    10_000,
    DATABASE_PROFILE_RUNTIME_CAPABILITY
  )
  return result.deleted
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

export function loadDatabaseCatalog(
  worktreeId: string,
  request: DatabaseConnectionRequest
): Promise<DatabaseCatalogResult> {
  // Why: catalog RPCs were introduced with database.profile.v1; runtimes that
  // only advertise database.query.v1 do not expose database.catalog yet.
  return callDatabaseRuntimeRpc(
    worktreeId,
    'database.catalog',
    withProjectExecution(worktreeId, request),
    35_000,
    DATABASE_PROFILE_RUNTIME_CAPABILITY
  )
}

const queryTargets = new Map<string, { worktreeId: string; target: RuntimeClientTarget }>()

export async function executeDatabaseQuery(
  worktreeId: string,
  request: DatabaseQueryRequest
): Promise<DatabaseQueryResult> {
  if (queryTargets.has(request.queryId)) {
    throw new Error('A query with this id is already running')
  }
  const target = getDatabaseTarget(worktreeId)
  queryTargets.set(request.queryId, { worktreeId, target })
  try {
    return await callDatabaseRuntimeRpc(
      worktreeId,
      'database.execute',
      withProjectExecution(worktreeId, request),
      request.timeoutMs + 10_000,
      DATABASE_QUERY_RUNTIME_CAPABILITY,
      target
    )
  } finally {
    queryTargets.delete(request.queryId)
  }
}

export async function cancelDatabaseQuery(
  worktreeId: string,
  providerId: DatabaseProviderId,
  queryId: string
): Promise<boolean> {
  const pending = queryTargets.get(queryId)
  if (!pending || pending.worktreeId !== worktreeId) {
    return false
  }
  const result = await callDatabaseRuntimeRpc<{ canceled: boolean }>(
    worktreeId,
    'database.cancel',
    { providerId, queryId },
    5_000,
    DATABASE_QUERY_RUNTIME_CAPABILITY,
    pending.target
  )
  return result.canceled
}
