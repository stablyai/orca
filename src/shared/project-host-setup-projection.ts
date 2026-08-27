import { getRepoExecutionHostId } from './execution-host'
import {
  normalizeProjectHostSetupRow,
  normalizeProjectRow
} from './project-catalog-row-normalization'
import { normalizeGitHubRemoteHost } from './git-remote-host-alias'
import { githubRepoIdentityKey, isDefaultGitHubHost } from './github/repository-identity-key'
import type { Project, ProjectHostSetup, ProjectProviderIdentity } from './project-types'
import type { Repo } from './repo-types'
import type { WorktreeMeta } from './worktree/meta-types'

type ProjectAccumulator = {
  project: Project
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
    // Why: repo auto-detect can know the GitHub slug through the generated
    // avatar icon even when legacy `upstream` has not been backfilled yet.
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
  // Why: the remote URL retains HTTP(S) endpoint ports that the canonical
  // key omits, so prefer it when reconstructing a host-qualified GHES identity.
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

/** True when the repo resolves to a GitHub provider identity (via explicit
 *  upstream or a GitHub-sourced avatar icon). Used to scope GitHub-CLI setup
 *  prompts to users who actually have GitHub-backed projects. */
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

/** True while nothing has settled the repo's remote identity yet: the background
 *  probe has not answered (or could not reach the host), as distinct from the
 *  resolved `null` marker meaning "checked, no usable remote". Provider-neutral —
 *  GitHub repos usually settle through persisted `upstream` instead. */
export function isProjectRemoteIdentityPending(
  repo: Pick<Repo, 'upstream' | 'repoIcon' | 'gitRemoteIdentity'>
): boolean {
  return repo.gitRemoteIdentity === undefined && !hasProjectRemoteIdentity(repo)
}

const HOST_LOCAL_PROJECT_ID_PREFIX = 'repo:'

export function getProjectIdentityKey(
  repo: Pick<Repo, 'id' | 'upstream' | 'repoIcon' | 'gitRemoteIdentity'>
): string {
  const identity = getProjectProviderIdentity(repo)
  if (identity) {
    return getProjectIdForProviderIdentity(identity)
  }
  const gitRemoteIdentity = getProjectGitRemoteIdentity(repo)
  if (gitRemoteIdentity) {
    return `git:${gitRemoteIdentity.canonicalKey}`
  }
  return `${HOST_LOCAL_PROJECT_ID_PREFIX}${repo.id}`
}

/**
 * True for the `repo:<id>` fallback above — a folder project, or a git repo with no
 * remote. The id is a per-host repo id, so the same project on another host derives a
 * different one and can never be matched there.
 */
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
  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i)
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

// Why: `addedAt || now` restamps Date.now() when addedAt is 0 / absent / NaN, so every
// projection looks dirty and reconcileCatalogRows never reuses the project or setup.
function catalogTimestampFromAddedAt(addedAt: number): number {
  return Number.isFinite(addedAt) ? addedAt : 0
}

// Why: 0 / absent / NaN means "the repo predates timestamped catalog rows", not epoch. Keeping
// it out of min()/max() stops one unknown sibling from wiping a real timestamp — and unlike the
// old `|| now` fallback it stays order-independent, so both merge orders agree.
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

function createProjectFromRepo(repo: Repo): Project {
  const identity = getProjectProviderIdentity(repo)
  const gitRemoteIdentity = getProjectGitRemoteIdentity(repo)
  const addedAt = catalogTimestampFromAddedAt(repo.addedAt)
  return {
    id: getProjectId(repo),
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

function mergeProjectRepo(project: Project, repo: Repo): Project {
  const sourceRepoIds = project.sourceRepoIds.includes(repo.id)
    ? project.sourceRepoIds
    : [...project.sourceRepoIds, repo.id]
  // Why unknown-aware on both sides: the accumulator itself carries 0 when the first repo of the
  // project had no addedAt, so a plain min() would let repo order decide the project's createdAt.
  const addedAt = catalogTimestampFromAddedAt(repo.addedAt)
  return {
    ...project,
    sourceRepoIds,
    createdAt: mergeCatalogCreatedAt(project.createdAt, addedAt),
    updatedAt: mergeCatalogUpdatedAt(project.updatedAt, addedAt)
  }
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
    const project = existing
      ? mergeProjectRepo(existing.project, repo)
      : createProjectFromRepo(repo)
    // Why normalize here: a repo row is untrusted persisted/wire data too, and these
    // constructors copy repo.path / repo.id straight onto fields consumers call .trim() on.
    const setup = normalizeProjectHostSetupRow(createSetupFromRepo(repo, projectId))
    projectById.set(projectId, {
      project
    })
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

export function getProjectHostSetupForRepo(
  setups: readonly ProjectHostSetup[],
  repo: Repo
): ProjectHostSetup {
  return (
    setups.find((setup) => setup.repoId === repo.id) ??
    projectHostSetupProjectionFromRepos([repo]).setups[0]
  )
}

export function getProjectHostSetupWorktreeMeta(
  setups: readonly ProjectHostSetup[],
  repo: Repo
): Pick<WorktreeMeta, 'projectId' | 'hostId' | 'projectHostSetupId'> {
  const setup = getProjectHostSetupForRepo(setups, repo)
  return {
    projectId: setup.projectId,
    hostId: setup.hostId,
    projectHostSetupId: setup.id
  }
}
