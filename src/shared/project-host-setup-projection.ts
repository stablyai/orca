import { getRepoExecutionHostId } from './execution-host'
import type {
  Project,
  ProjectHostSetup,
  ProjectProviderIdentity,
  Repo,
  WorktreeMeta
} from './types'

type ProjectAccumulator = {
  project: Project
}

export type ProjectHostSetupProjection = {
  projects: Project[]
  setups: ProjectHostSetup[]
}

function normalizeIdentityPart(value: string): string {
  return value.trim().toLowerCase()
}

function getProjectProviderIdentity(
  repo: Pick<Repo, 'upstream' | 'repoIcon'>
): ProjectProviderIdentity | null {
  const owner = typeof repo.upstream?.owner === 'string' ? repo.upstream.owner.trim() : ''
  const name = typeof repo.upstream?.repo === 'string' ? repo.upstream.repo.trim() : ''
  if (owner && name) {
    return { provider: 'github', owner, repo: name }
  }
  if (repo.repoIcon?.type !== 'image' || repo.repoIcon.source !== 'github') {
    return null
  }
  const parts = (repo.repoIcon.label?.trim() ?? '').split('/')
  const iconOwner = parts[0]?.trim()
  const iconRepo = parts[1]?.trim()
  // Why: repo auto-detect can know the GitHub slug through the generated
  // avatar icon even when legacy `upstream` has not been backfilled yet.
  return iconOwner && iconRepo && parts.length === 2
    ? { provider: 'github', owner: iconOwner, repo: iconRepo }
    : null
}

export function getProjectIdentityKey(repo: Pick<Repo, 'id' | 'upstream' | 'repoIcon'>): string {
  const identity = getProjectProviderIdentity(repo)
  if (!identity) {
    return `repo:${repo.id}`
  }
  return `github:${normalizeIdentityPart(identity.owner)}/${normalizeIdentityPart(identity.repo)}`
}

function getProjectId(repo: Pick<Repo, 'id' | 'upstream' | 'repoIcon'>): string {
  return getProjectIdentityKey(repo)
}

function createProjectFromRepo(repo: Repo, now: number): Project {
  const identity = getProjectProviderIdentity(repo)
  return {
    id: getProjectId(repo),
    displayName: repo.displayName,
    badgeColor: repo.badgeColor,
    ...(repo.repoIcon !== undefined ? { repoIcon: repo.repoIcon } : {}),
    ...(repo.kind ? { kind: repo.kind } : {}),
    ...(identity ? { providerIdentity: identity } : {}),
    sourceRepoIds: [repo.id],
    createdAt: repo.addedAt || now,
    updatedAt: repo.addedAt || now
  }
}

function mergeProjectRepo(project: Project, repo: Repo): Project {
  const sourceRepoIds = project.sourceRepoIds.includes(repo.id)
    ? project.sourceRepoIds
    : [...project.sourceRepoIds, repo.id]
  return {
    ...project,
    sourceRepoIds,
    createdAt: Math.min(project.createdAt, repo.addedAt || project.createdAt),
    updatedAt: Math.max(project.updatedAt, repo.addedAt || project.updatedAt)
  }
}

function createSetupFromRepo(repo: Repo, projectId: string, now: number): ProjectHostSetup {
  const hostId = getRepoExecutionHostId(repo)
  const createdAt = repo.addedAt || now
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
  now = Date.now()
): ProjectHostSetupProjection {
  const projectById = new Map<string, ProjectAccumulator>()
  const setups: ProjectHostSetup[] = []

  for (const repo of repos) {
    const projectId = getProjectId(repo)
    const existing = projectById.get(projectId)
    const project = existing
      ? mergeProjectRepo(existing.project, repo)
      : createProjectFromRepo(repo, now)
    const setup = createSetupFromRepo(repo, projectId, now)
    projectById.set(projectId, {
      project
    })
    setups.push(setup)
  }

  return {
    projects: [...projectById.values()].map((entry) => entry.project),
    setups
  }
}

export function getProjectHostSetupsForProject(
  setups: readonly ProjectHostSetup[],
  projectId: string
): ProjectHostSetup[] {
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
