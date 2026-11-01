import { getRepoExecutionHostId } from './execution-host'
import {
  normalizeProjectHostSetupRow,
  normalizeProjectRow
} from './project-catalog-row-normalization'
import { normalizeGitHubRemoteHost } from './git-remote-host-alias'
import { githubRepoIdentityKey, isDefaultGitHubHost } from './github/repository-identity-key'
import type { Project, ProjectHostSetup, ProjectProviderIdentity } from './project-types'
import type { Repo } from './repo-types'

/** Own fresh mutable project drafts: using persisted/caller rows leaks mergeProjectRepo writes. Mirror sourceRepoIds in a set
 * to avoid membership rescans. */
type ProjectAccumulator = {
  project: Project
  sourceRepoIds: Set<string>
}

export type ProjectHostSetupProjection = {
  projects: readonly Project[]
  setups: readonly ProjectHostSetup[]
}

export function getProjectProviderIdentity(
  repo: Pick<Repo, 'upstream' | 'repoIcon' | 'gitRemoteIdentity'>
): ProjectProviderIdentity | null {
  const owner = typeof repo.upstream?.owner === 'string' ? repo.upstream.owner.trim() : ''
  const name = typeof repo.upstream?.repo === 'string' ? repo.upstream.repo.trim() : ''
  if (owner && name) {
    return {
      provider: 'github',
      owner,
      repo: name,
      ...(repo.upstream?.host ? { host: repo.upstream.host } : {})
    }
  }
  if (repo.repoIcon?.type === 'image' && repo.repoIcon.source === 'github') {
    const parts = (repo.repoIcon.label?.trim() ?? '').split('/')
    const iconOwner = parts[0]?.trim()
    const iconRepo = parts[1]?.trim()
    // Generated GitHub avatars can retain slugs when legacy upstream fields are not backfilled.
    if (iconOwner && iconRepo && parts.length === 2) {
      let host: string | undefined
      try {
        const url = new URL(repo.repoIcon.src)
        host = url.protocol === 'https:' ? url.host : undefined
      } catch {
        // Legacy persisted icons can be malformed; keep the host-less fallback.
      }
      return {
        provider: 'github',
        owner: iconOwner,
        repo: iconRepo,
        ...(host && !isDefaultGitHubHost(host) ? { host } : {})
      }
    }
  }
  return getGitRemoteProviderIdentity(repo)
}

/** The GitHub identity the folder's own primary remote names, ignoring stamped `upstream`. */
export function getGitRemoteProviderIdentity(
  repo: Pick<Repo, 'gitRemoteIdentity'>
): ProjectProviderIdentity | null {
  // Prefer remote URLs preserving HTTP(S) API ports over canonical keys that omit them (GHES).
  return (
    parseGitHubRemoteUrl(repo.gitRemoteIdentity?.remoteUrl) ??
    parseGitHubCanonicalKey(repo.gitRemoteIdentity?.canonicalKey)
  )
}

function getProjectGitRemoteIdentity(
  repo: Pick<Repo, 'gitRemoteIdentity'>
): NonNullable<Repo['gitRemoteIdentity']> | null {
  const identity = repo.gitRemoteIdentity
  const canonicalKey =
    typeof identity?.canonicalKey === 'string' ? identity.canonicalKey.trim() : ''
  const remoteName = typeof identity?.remoteName === 'string' ? identity.remoteName.trim() : ''
  const remoteUrl = typeof identity?.remoteUrl === 'string' ? identity.remoteUrl.trim() : ''
  return canonicalKey && remoteName && remoteUrl ? { canonicalKey, remoteName, remoteUrl } : null
}

/** Limit gh setup prompts to GitHub-backed projects proven by remote, explicit upstream or generated GitHub avatar. */
export function isGitHubBackedRepo(
  repo: Pick<Repo, 'upstream' | 'repoIcon' | 'gitRemoteIdentity'>
): boolean {
  return getProjectProviderIdentity(repo) !== null
}

export function hasProjectRemoteIdentity(
  repo: Pick<Repo, 'upstream' | 'repoIcon' | 'gitRemoteIdentity'>
): boolean {
  return getProjectProviderIdentity(repo) !== null || getProjectGitRemoteIdentity(repo) !== null
}

/** Undefined remote identity is pending/unreachable, distinct from resolved null (checked, unusable).
 * Provider-neutral; GitHub repos usually resolve via persisted upstream. */
export function isProjectRemoteIdentityPending(
  repo: Pick<Repo, 'upstream' | 'repoIcon' | 'gitRemoteIdentity'>
): boolean {
  return repo.gitRemoteIdentity === undefined && !hasProjectRemoteIdentity(repo)
}

const HOST_LOCAL_PROJECT_ID_PREFIX = 'repo:'
/** A project keyed by its primary Git remote rather than a provider identity. */
export const GIT_REMOTE_PROJECT_ID_PREFIX = 'git:'

export function getProjectIdentityKey(
  repo: Pick<Repo, 'id' | 'upstream' | 'repoIcon' | 'gitRemoteIdentity'>
): string {
  const identity = getProjectProviderIdentity(repo)
  if (identity) {
    return getProjectIdForProviderIdentity(identity)
  }
  const gitRemoteIdentity = getProjectGitRemoteIdentity(repo)
  if (gitRemoteIdentity) {
    return `${GIT_REMOTE_PROJECT_ID_PREFIX}${gitRemoteIdentity.canonicalKey}`
  }
  return `${HOST_LOCAL_PROJECT_ID_PREFIX}${repo.id}`
}

/** repo:<id> fallback is host-local (folders/remote-less repos); identical projects elsewhere derive different IDs. */
export function isHostLocalProjectId(projectId: string): boolean {
  return projectId.startsWith(HOST_LOCAL_PROJECT_ID_PREFIX)
}

export function getProjectIdForProviderIdentity(identity: ProjectProviderIdentity): string {
  return `github:${githubRepoIdentityKey(identity)}`
}

function getProjectId(
  repo: Pick<Repo, 'id' | 'upstream' | 'repoIcon' | 'gitRemoteIdentity'>
): string {
  return getProjectIdentityKey(repo)
}

function isGitHubRemoteHost(host: string): boolean {
  const hostname = host.toLowerCase().replace(/:\d+$/, '')
  // A generic git remote is provider-neutral. Only infer GHES when the host
  // itself carries a GitHub/GHE signal; upstream/icon metadata handles custom names.
  return (
    isDefaultGitHubHost(hostname) ||
    hostname.startsWith('github.') ||
    hostname.startsWith('github-') ||
    hostname.startsWith('ghe.') ||
    hostname.startsWith('ghe-')
  )
}

function projectProviderIdentity(
  host: string,
  owner: string,
  repo: string
): ProjectProviderIdentity | null {
  const normalizedHost = normalizeGitHubRemoteHost(host)
  if (!isGitHubRemoteHost(normalizedHost)) {
    return null
  }
  return {
    provider: 'github',
    owner,
    repo,
    ...(!isDefaultGitHubHost(normalizedHost) ? { host: normalizedHost } : {})
  }
}

function parseGitHubRemotePath(path: string): { owner: string; repo: string } | null {
  const parts = path.replace(/^\/+/, '').replace(/\/+$/, '').split('/')
  if (parts.length !== 2) {
    return null
  }
  const [owner, repoWithSuffix] = parts
  const repo = repoWithSuffix?.replace(/\.git$/i, '')
  return owner && repo ? { owner, repo } : null
}

function parseGitHubCanonicalKey(canonicalKey: string | undefined): ProjectProviderIdentity | null {
  const trimmed = canonicalKey?.trim()
  if (!trimmed) {
    return null
  }
  const slash = trimmed.indexOf('/')
  if (slash <= 0) {
    return null
  }
  const host = trimmed.slice(0, slash)
  const path = parseGitHubRemotePath(trimmed.slice(slash + 1))
  return path ? projectProviderIdentity(host, path.owner, path.repo) : null
}

function parseGitHubRemoteUrl(remoteUrl: string | undefined): ProjectProviderIdentity | null {
  const trimmed = remoteUrl?.trim()
  if (!trimmed) {
    return null
  }
  // Why: SSH certificate orgs use `org-<id>@github.com:<owner>/<repo>`, so the user is not always `git`.
  const sshMatch = trimmed.match(/^[^@\s/:]+@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i)
  if (sshMatch?.[1] && sshMatch[2] && sshMatch[3]) {
    return projectProviderIdentity(sshMatch[1], sshMatch[2], sshMatch[3])
  }
  try {
    const url = new URL(trimmed)
    if (!['git:', 'git+ssh:', 'http:', 'https:', 'ssh:'].includes(url.protocol.toLowerCase())) {
      return null
    }
    const path = parseGitHubRemotePath(url.pathname)
    if (!path) {
      return null
    }
    // HTTP ports identify the API endpoint; SSH/git ports are transport-only.
    const host = url.protocol === 'http:' || url.protocol === 'https:' ? url.host : url.hostname
    return projectProviderIdentity(host, path.owner, path.repo)
  } catch {
    return null
  }
}

// Do not restamp missing/zero/NaN addedAt with now: every projection would look dirty and defeat row reuse.
function catalogTimestampFromAddedAt(addedAt: number): number {
  return Number.isFinite(addedAt) ? addedAt : 0
}

// Exclude unknown timestamps from min/max so they cannot erase known siblings; retain order-independent results without now fallbacks.
function knownCatalogTimestamp(value: number): number | undefined {
  return Number.isFinite(value) && value !== 0 ? value : undefined
}

/** Oldest of two catalog `createdAt` values, treating 0/NaN on either side as unknown. */
export function mergeCatalogCreatedAt(left: number, right: number): number {
  const known = knownCatalogTimestamp(left)
  const other = knownCatalogTimestamp(right)
  if (known === undefined || other === undefined) {
    return known ?? other ?? 0
  }
  return Math.min(known, other)
}

/** Newest of two catalog `updatedAt` values, treating 0/NaN on either side as unknown. */
export function mergeCatalogUpdatedAt(left: number, right: number): number {
  const known = knownCatalogTimestamp(left)
  const other = knownCatalogTimestamp(right)
  if (known === undefined || other === undefined) {
    return known ?? other ?? 0
  }
  return Math.max(known, other)
}

function createProjectFromRepo(repo: Repo, projectId: string): Project {
  const identity = getProjectProviderIdentity(repo)
  const gitRemoteIdentity = getProjectGitRemoteIdentity(repo)
  const addedAt = catalogTimestampFromAddedAt(repo.addedAt)
  return {
    id: projectId,
    displayName: repo.displayName,
    badgeColor: repo.badgeColor,
    ...(repo.repoIcon !== undefined ? { repoIcon: repo.repoIcon } : {}),
    ...(repo.kind ? { kind: repo.kind } : {}),
    ...(identity ? { providerIdentity: identity } : {}),
    ...(gitRemoteIdentity ? { gitRemoteIdentity } : {}),
    sourceRepoIds: [repo.id],
    createdAt: addedAt,
    updatedAt: addedAt
  }
}

/** Mutates the draft in place — only ever call this on an accumulator this projection owns. */
function mergeProjectRepo(accumulator: ProjectAccumulator, repo: Repo): void {
  const { project, sourceRepoIds } = accumulator
  if (!sourceRepoIds.has(repo.id)) {
    sourceRepoIds.add(repo.id)
    project.sourceRepoIds.push(repo.id)
  }
  const addedAt = catalogTimestampFromAddedAt(repo.addedAt)
  project.createdAt = mergeCatalogCreatedAt(project.createdAt, addedAt)
  project.updatedAt = mergeCatalogUpdatedAt(project.updatedAt, addedAt)
}

function createSetupFromRepo(repo: Repo, projectId: string): ProjectHostSetup {
  const hostId = getRepoExecutionHostId(repo)
  const createdAt = catalogTimestampFromAddedAt(repo.addedAt)
  const setupMethod = repo.projectHostSetupMethod ?? 'legacy-repo'
  return {
    id: repo.id,
    projectId,
    hostId,
    repoId: repo.id,
    path: repo.path,
    displayName: repo.displayName,
    ...(repo.kind ? { kind: repo.kind } : {}),
    ...(repo.connectionId !== undefined ? { connectionId: repo.connectionId } : {}),
    ...(repo.executionHostId !== undefined ? { executionHostId: repo.executionHostId } : {}),
    ...(repo.worktreeBasePath ? { worktreeBasePath: repo.worktreeBasePath } : {}),
    ...(repo.hookSettings ? { hookSettings: repo.hookSettings } : {}),
    ...(repo.gitUsername ? { gitUsername: repo.gitUsername } : {}),
    ...(repo.sourceControlAi ? { sourceControlAi: repo.sourceControlAi } : {}),
    setupState: 'ready',
    setupMethod,
    createdAt,
    updatedAt: createdAt
  }
}

export function projectHostSetupProjectionFromRepos(
  repos: readonly Repo[],
  _now?: number
): ProjectHostSetupProjection {
  const projectById = new Map<string, ProjectAccumulator>()
  const setups: ProjectHostSetup[] = []

  for (const repo of repos) {
    const projectId = getProjectId(repo)
    const existing = projectById.get(projectId)
    if (existing) {
      mergeProjectRepo(existing, repo)
    } else {
      const project = createProjectFromRepo(repo, projectId)
      projectById.set(projectId, { project, sourceRepoIds: new Set(project.sourceRepoIds) })
    }
    // Repo rows are untrusted too; normalize constructors copying id/path into fields callers trim.
    const setup = normalizeProjectHostSetupRow(createSetupFromRepo(repo, projectId))
    setups.push(setup)
  }

  return {
    projects: [...projectById.values()].map((entry) => normalizeProjectRow(entry.project)),
    setups
  }
}

export function getProjectHostSetupsForProject(
  setups: readonly ProjectHostSetup[],
  projectId: string
): readonly ProjectHostSetup[] {
  return setups.filter((setup) => setup.projectId === projectId)
}
