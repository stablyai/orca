import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from './execution-host'
import type { GlobalSettings, ProjectProviderIdentity, Repo } from './types'

export type TaskProvider = 'github' | 'gitlab' | 'linear' | 'jira'

export type GitHubTaskProviderIdentity = ProjectProviderIdentity & {
  provider: 'github'
}

export type GitLabTaskProviderIdentity = {
  provider: 'gitlab'
  projectId?: string | null
  namespace?: string | null
  project?: string | null
  webUrl?: string | null
}

export type LinearTaskProviderIdentity = {
  provider: 'linear'
  workspaceId?: string | null
  workspaceName?: string | null
  teamId?: string | null
  teamKey?: string | null
}

export type JiraTaskProviderIdentity = {
  provider: 'jira'
  siteId?: string | null
  siteUrl?: string | null
  projectKey?: string | null
}

export type TaskProviderIdentity =
  | GitHubTaskProviderIdentity
  | GitLabTaskProviderIdentity
  | LinearTaskProviderIdentity
  | JiraTaskProviderIdentity

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
    providerIdentityCachePart(context.providerIdentity)
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

export function getWorkspaceRunRuntimeSettings(
  context: Pick<WorkspaceRunContext, 'hostId'> | null | undefined
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> {
  return getTaskSourceRuntimeSettings(context ? { hostId: context.hostId } : null)
}

function getRepoHostId(repo: Pick<Repo, 'connectionId' | 'executionHostId'>): ExecutionHostId {
  const explicit = normalizeExecutionHostId(repo.executionHostId)
  if (explicit) {
    return explicit
  }
  const connectionId = normalizeNonEmptyString(repo.connectionId)
  return connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID
}

function normalizeTaskProvider(value: string): TaskProvider | null {
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

function normalizeTaskProviderIdentity(
  provider: TaskProvider,
  identity: TaskProviderIdentity | null | undefined
): TaskProviderIdentity | null {
  if (!identity || identity.provider !== provider) {
    return null
  }
  return identity
}

function normalizeNonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function providerIdentityCachePart(identity: TaskProviderIdentity | null | undefined): string {
  if (!identity) {
    return ''
  }
  switch (identity.provider) {
    case 'github':
      return [identity.owner, identity.repo].join('/')
    case 'gitlab':
      return identity.projectId ?? [identity.namespace, identity.project].filter(Boolean).join('/')
    case 'linear':
      return [identity.workspaceId, identity.teamId ?? identity.teamKey].filter(Boolean).join('/')
    case 'jira':
      return [identity.siteId ?? identity.siteUrl, identity.projectKey].filter(Boolean).join('/')
  }
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
