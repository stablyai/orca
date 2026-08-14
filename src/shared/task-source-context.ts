import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from './execution-host'
import {
  areTaskProviderIdentitiesEqual,
  isStoredTaskProviderIdentity,
  normalizeTaskProviderIdentity,
  taskProviderIdentityCachePart,
  type TaskProviderIdentity
} from './task-provider-identity'
import type { TaskProvider } from './task-providers'
import type { GlobalSettings } from './global-settings-types'
import type { Repo } from './repo-types'

export type {
  GitHubTaskProviderIdentity,
  GitLabTaskProviderIdentity,
  JiraTaskProviderIdentity,
  LinearTaskProviderIdentity,
  TaskProviderIdentity
} from './task-provider-identity'
export type { TaskProvider } from './task-providers'

export type TaskSourceContext = {
  kind: 'task-source'
  provider: TaskProvider
  projectId: string
  hostId: ExecutionHostId
  projectHostSetupId?: string | null
  repoId?: string | null
  providerIdentity?: TaskProviderIdentity | null
  accountLabel?: string | null
}

export type WorkspaceRunContext = {
  kind: 'workspace-run'
  projectId: string
  hostId: ExecutionHostId
  projectHostSetupId: string
  repoId: string
  path: string
}

export type TaskSourceContextInput = Omit<TaskSourceContext, 'kind' | 'hostId'> & {
  kind?: 'task-source'
  hostId?: string | null
}

export function normalizeTaskSourceContext(
  input: TaskSourceContextInput
): TaskSourceContext | null {
  const projectId = normalizeNonEmptyString(input.projectId)
  if (!projectId) {
    return null
  }
  const provider = normalizeTaskProvider(input.provider)
  if (!provider) {
    return null
  }
  return {
    kind: 'task-source',
    provider,
    projectId,
    hostId: normalizeExecutionHostId(input.hostId) ?? LOCAL_EXECUTION_HOST_ID,
    projectHostSetupId: normalizeNonEmptyString(input.projectHostSetupId),
    repoId: normalizeNonEmptyString(input.repoId),
    providerIdentity: normalizeTaskProviderIdentity(provider, input.providerIdentity),
    accountLabel: normalizeNonEmptyString(input.accountLabel)
  }
}

export function normalizeStoredTaskSourceContext(value: unknown): TaskSourceContext | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const input = value as Record<string, unknown>
  const provider = normalizeTaskProvider(input.provider)
  if (
    !provider ||
    typeof input.projectId !== 'string' ||
    (input.kind !== undefined && input.kind !== 'task-source') ||
    !isNullableOptionalString(input.hostId) ||
    !isNullableOptionalString(input.projectHostSetupId) ||
    !isNullableOptionalString(input.repoId) ||
    !isNullableOptionalString(input.accountLabel) ||
    !isStoredTaskProviderIdentity(provider, input.providerIdentity)
  ) {
    return null
  }
  if (
    typeof input.hostId === 'string' &&
    input.hostId.trim().length > 0 &&
    normalizeExecutionHostId(input.hostId) === null
  ) {
    return null
  }
  return normalizeTaskSourceContext(input as TaskSourceContextInput)
}

export function buildTaskSourceContextFromRepo(args: {
  provider: TaskProvider
  projectId: string
  repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>
  projectHostSetupId?: string | null
  providerIdentity?: TaskProviderIdentity | null
  accountLabel?: string | null
}): TaskSourceContext | null {
  return normalizeTaskSourceContext({
    provider: args.provider,
    projectId: args.projectId,
    hostId: getRepoHostId(args.repo),
    repoId: args.repo.id,
    projectHostSetupId: args.projectHostSetupId,
    providerIdentity: args.providerIdentity,
    accountLabel: args.accountLabel
  })
}

export function areTaskSourceContextsEqual(
  a: TaskSourceContext | null | undefined,
  b: TaskSourceContext | null | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b) {
    return !a && !b
  }
  return (
    a.provider === b.provider &&
    a.projectId === b.projectId &&
    a.hostId === b.hostId &&
    (a.projectHostSetupId ?? null) === (b.projectHostSetupId ?? null) &&
    (a.repoId ?? null) === (b.repoId ?? null) &&
    (a.accountLabel ?? null) === (b.accountLabel ?? null) &&
    areTaskProviderIdentitiesEqual(a.providerIdentity, b.providerIdentity)
  )
}

export function getTaskSourceRuntimeSettings(
  context: Pick<TaskSourceContext, 'hostId'> | null | undefined
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> {
  const parsed = parseExecutionHostId(context?.hostId)
  return {
    activeRuntimeEnvironmentId: parsed?.kind === 'runtime' ? parsed.environmentId : null
  }
}

export function getTaskSourceCacheScope(
  context: Pick<TaskSourceContext, 'provider' | 'hostId' | 'projectId' | 'projectHostSetupId'> & {
    providerIdentity?: TaskProviderIdentity | null
    repoId?: string | null
  }
): string {
  return [
    context.provider,
    context.hostId,
    context.projectId,
    context.projectHostSetupId ?? '',
    context.repoId ?? '',
    taskProviderIdentityCachePart(context.providerIdentity)
  ]
    .map(encodeCachePart)
    .join(':')
}

export function buildWorkspaceRunContext(args: {
  projectId: string
  hostId: string | null | undefined
  projectHostSetupId: string
  repoId: string
  path: string
}): WorkspaceRunContext | null {
  const projectId = normalizeNonEmptyString(args.projectId)
  const projectHostSetupId = normalizeNonEmptyString(args.projectHostSetupId)
  const repoId = normalizeNonEmptyString(args.repoId)
  const repoPath = normalizeNonEmptyString(args.path)
  if (!projectId || !projectHostSetupId || !repoId || !repoPath) {
    return null
  }
  return {
    kind: 'workspace-run',
    projectId,
    hostId: normalizeExecutionHostId(args.hostId) ?? LOCAL_EXECUTION_HOST_ID,
    projectHostSetupId,
    repoId,
    path: repoPath
  }
}

function getRepoHostId(repo: Pick<Repo, 'connectionId' | 'executionHostId'>): ExecutionHostId {
  const explicit = normalizeExecutionHostId(repo.executionHostId)
  if (explicit) {
    return explicit
  }
  const connectionId = normalizeNonEmptyString(repo.connectionId)
  return connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID
}

function normalizeTaskProvider(value: unknown): TaskProvider | null {
  switch (value) {
    case 'github':
    case 'gitlab':
    case 'linear':
    case 'jira':
      return value
    default:
      return null
  }
}

function normalizeNonEmptyString(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed ? trimmed : null
}

function isNullableOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string'
}

function encodeCachePart(value: string): string {
  return encodeURIComponent(value)
}

export function runtimeHostIdFromEnvironmentId(
  environmentId: string | null | undefined
): ExecutionHostId {
  const trimmed = normalizeNonEmptyString(environmentId)
  return trimmed ? toRuntimeExecutionHostId(trimmed) : LOCAL_EXECUTION_HOST_ID
}
