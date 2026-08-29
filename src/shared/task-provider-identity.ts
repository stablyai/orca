import { githubRepoIdentityKey } from './github/repository-identity-key'
import type { TaskProvider } from './task-providers'
import type { ProjectProviderIdentity } from './project-types'

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

export function normalizeTaskProviderIdentity(
  provider: TaskProvider,
  identity: unknown
): TaskProviderIdentity | null {
  if (!identity || typeof identity !== 'object') {
    return null
  }
  const raw = identity as Record<string, unknown>
  if (raw.provider !== provider) {
    return null
  }
  switch (provider) {
    case 'github': {
      const owner = normalizeNonEmptyString(raw.owner)
      const repo = normalizeNonEmptyString(raw.repo)
      if (!owner || !repo) {
        return null
      }
      const host = normalizeNonEmptyString(raw.host)
      return { provider, owner, repo, ...(host ? { host } : {}) }
    }
    case 'gitlab':
      return {
        provider,
        projectId: normalizeNonEmptyString(raw.projectId),
        namespace: normalizeNonEmptyString(raw.namespace),
        project: normalizeNonEmptyString(raw.project),
        webUrl: normalizeNonEmptyString(raw.webUrl)
      }
    case 'linear':
      return {
        provider,
        workspaceId: normalizeNonEmptyString(raw.workspaceId),
        workspaceName: normalizeNonEmptyString(raw.workspaceName),
        teamId: normalizeNonEmptyString(raw.teamId),
        teamKey: normalizeNonEmptyString(raw.teamKey)
      }
    case 'jira':
      return {
        provider,
        siteId: normalizeNonEmptyString(raw.siteId),
        siteUrl: normalizeNonEmptyString(raw.siteUrl),
        projectKey: normalizeNonEmptyString(raw.projectKey)
      }
  }
}

export function isStoredTaskProviderIdentity(provider: TaskProvider, identity: unknown): boolean {
  if (identity === undefined || identity === null) {
    return true
  }
  if (typeof identity !== 'object') {
    return false
  }
  const raw = identity as Record<string, unknown>
  if (raw.provider !== provider) {
    return false
  }
  switch (provider) {
    case 'github':
      return (
        typeof raw.owner === 'string' &&
        raw.owner.trim().length > 0 &&
        typeof raw.repo === 'string' &&
        raw.repo.trim().length > 0 &&
        isNullableOptionalString(raw.host)
      )
    case 'gitlab':
      return ['projectId', 'namespace', 'project', 'webUrl'].every((key) =>
        isNullableOptionalString(raw[key])
      )
    case 'linear':
      return ['workspaceId', 'workspaceName', 'teamId', 'teamKey'].every((key) =>
        isNullableOptionalString(raw[key])
      )
    case 'jira':
      return ['siteId', 'siteUrl', 'projectKey'].every((key) => isNullableOptionalString(raw[key]))
  }
}

const TASK_PROVIDER_IDENTITY_FIELDS: Record<TaskProvider, readonly string[]> = {
  github: ['owner', 'repo', 'host'],
  gitlab: ['projectId', 'namespace', 'project', 'webUrl'],
  linear: ['workspaceId', 'workspaceName', 'teamId', 'teamKey'],
  jira: ['siteId', 'siteUrl', 'projectKey']
}

export function areTaskProviderIdentitiesEqual(
  a: TaskProviderIdentity | null | undefined,
  b: TaskProviderIdentity | null | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b) {
    return !a && !b
  }
  if (a.provider !== b.provider) {
    return false
  }
  const left = a as unknown as Record<string, unknown>
  const right = b as unknown as Record<string, unknown>
  return TASK_PROVIDER_IDENTITY_FIELDS[a.provider].every(
    (field) => (left[field] ?? null) === (right[field] ?? null)
  )
}

export function taskProviderIdentityCachePart(
  identity: TaskProviderIdentity | null | undefined
): string {
  if (!identity) {
    return ''
  }
  switch (identity.provider) {
    case 'github':
      return githubRepoIdentityKey(identity)
    case 'gitlab':
      return identity.projectId ?? [identity.namespace, identity.project].filter(Boolean).join('/')
    case 'linear':
      return [identity.workspaceId, identity.teamId ?? identity.teamKey].filter(Boolean).join('/')
    case 'jira':
      return [identity.siteId ?? identity.siteUrl, identity.projectKey].filter(Boolean).join('/')
  }
}

function normalizeNonEmptyString(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed ? trimmed : null
}

function isNullableOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string'
}
