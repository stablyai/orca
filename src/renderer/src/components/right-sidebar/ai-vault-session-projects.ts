import {
  getRepoHostIdentity,
  getRepoHostIdentityForParts
} from '../../../../shared/repo-host-identity'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { managedWorktreeDirectories } from '../../../../shared/worktree/ownership'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import { resolveActiveProjectKey } from './ai-vault-project-key'
import { toAiVaultProjectKey } from '../../../../shared/ai-vault-project-key'
import {
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { ProjectHostSetupProjection } from '../../../../shared/project-host-setup-projection'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { getProjectHostSetupLookup } from '../../../../shared/project-host-setup-lookup'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import {
  compareAiVaultProjectCandidates,
  folderProject,
  canonicalAiVaultSessionProject,
  aiVaultSessionProjectCwdKey,
  matchAiVaultProjectCandidates,
  makeProjectCandidate,
  resolveCandidateHostId,
  hasCandidatePath,
  type SessionProjectCandidate
} from './ai-vault-session-project-candidates'
import type { AiVaultSessionProject } from '../../../../shared/ai-vault-session-filters'
import {
  aiVaultCandidateProject,
  aiVaultFolderProject,
  resolveStructuredAiVaultSessionProject
} from './ai-vault-structured-session-project'

export type { AiVaultSessionProject } from '../../../../shared/ai-vault-session-filters'

export type AiVaultProjectContext = {
  activeProjectKey: string | null
  activeRepoId: string | null
  projectLabelByKey: Map<string, string>
  sessionProjectById: Map<string, AiVaultSessionProject>
}

type ProjectResolverArgs = {
  folderWorkspaces?: readonly FolderWorkspace[]
  repos: readonly Repo[]
  worktrees: readonly Worktree[]
  projectHostSetupProjection: ProjectHostSetupProjection
  activeRepo: Repo | null
  activeWorktree: Worktree | null
  sessions: readonly AiVaultSession[]
  settings?: Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces' | 'workspaceDirHistory'>
}

export function buildAiVaultProjectContext({
  folderWorkspaces,
  repos,
  worktrees,
  projectHostSetupProjection,
  activeRepo,
  activeWorktree,
  sessions,
  settings
}: ProjectResolverArgs): AiVaultProjectContext {
  const owners = getProjectHostSetupLookup(projectHostSetupProjection.setups)

  return {
    activeProjectKey: resolveActiveProjectKey(activeRepo, activeWorktree, owners),
    activeRepoId: activeRepo?.id ?? activeWorktree?.repoId ?? null,
    projectLabelByKey: buildProjectLabelByKey(repos, projectHostSetupProjection),
    sessionProjectById: buildAiVaultSessionProjectById({
      folderWorkspaces,
      repos,
      worktrees,
      projectHostSetupProjection,
      sessions,
      settings
    })
  }
}

/** Separate attribution from active workspace state so memoized maps survive workspace switches. */
export function buildAiVaultSessionProjectById({
  folderWorkspaces = [],
  repos,
  worktrees,
  projectHostSetupProjection,
  sessions,
  settings
}: Omit<ProjectResolverArgs, 'activeRepo' | 'activeWorktree'>): Map<string, AiVaultSessionProject> {
  const repoById = new Map(repos.map((repo) => [getRepoHostIdentity(repo), repo]))
  const owners = getProjectHostSetupLookup(projectHostSetupProjection.setups)
  const projectLabelByKey = buildProjectLabelByKey(repos, projectHostSetupProjection)
  const candidates = buildProjectCandidates(
    worktrees,
    projectHostSetupProjection,
    repoById,
    owners,
    settings
  )
  const sessionProjectById = new Map<string, AiVaultSessionProject>()
  const projectsByHostAndCwd = new Map<
    ExecutionHostId | null,
    Map<string | null, AiVaultSessionProject>
  >()
  for (const session of sessions) {
    const canonical = canonicalAiVaultSessionProject(session, projectLabelByKey)
    if (canonical) {
      sessionProjectById.set(session.id, canonical)
      continue
    }
    const host = normalizeExecutionHostId(session.executionHostId)
    const owned = resolveStructuredAiVaultSessionProject(
      session,
      candidates,
      folderWorkspaces,
      projectLabelByKey
    )
    if (owned) {
      sessionProjectById.set(session.id, owned)
      continue
    }
    let projectsByCwd = projectsByHostAndCwd.get(host)
    if (!projectsByCwd) {
      projectsByCwd = new Map()
      projectsByHostAndCwd.set(host, projectsByCwd)
    }
    const cwdKey = aiVaultSessionProjectCwdKey(session)
    let project = projectsByCwd.get(cwdKey)
    if (!project) {
      project = resolveSessionProject(session, candidates, projectLabelByKey)
      projectsByCwd.set(cwdKey, project)
    }
    sessionProjectById.set(session.id, { ...project })
  }
  return sessionProjectById
}

function buildProjectLabelByKey(
  repos: readonly Repo[],
  projection: ProjectHostSetupProjection
): Map<string, string> {
  const labels = new Map<string, string>()
  const projectLabelById = new Map(
    projection.projects.map((project) => [project.id, project.displayName])
  )

  for (const project of projection.projects) {
    const key = toAiVaultProjectKey(project.id, project.sourceRepoIds[0])
    if (key && !key.startsWith('repo:')) {
      labels.set(key, project.displayName)
    }
  }

  for (const repo of repos) {
    labels.set(`repo:${repo.id}`, repo.displayName)
  }

  for (const setup of projection.setups) {
    const key = toAiVaultProjectKey(setup.projectId, setup.repoId)
    if (key && !labels.has(key)) {
      labels.set(key, projectLabelById.get(setup.projectId) ?? setup.displayName)
    }
  }

  return labels
}

function buildProjectCandidates(
  worktrees: readonly Worktree[],
  projection: ProjectHostSetupProjection,
  repoById: ReadonlyMap<string, Repo>,
  owners: ReturnType<typeof getProjectHostSetupLookup>,
  settings?: ProjectResolverArgs['settings']
): SessionProjectCandidate[] {
  const candidates: SessionProjectCandidate[] = []
  const setupRepoIds = new Set<string>()
  const pathKey = (host: string, path: string) =>
    JSON.stringify([host, normalizeRuntimePathForComparison(path)])
  const occupied = new Set([
    ...worktrees.map((row) => pathKey(row.hostId ?? 'local', row.path)),
    ...projection.setups.map((row) => pathKey(row.executionHostId ?? row.hostId, row.path))
  ])

  for (const worktree of worktrees) {
    if (!hasCandidatePath(worktree.path)) {
      continue
    }
    const repo = repoById.get(
      getRepoHostIdentityForParts(worktree.repoId, worktree.hostId ?? 'local')
    )
    const setup = owners.forWorkspace(worktree)
    const candidate = makeProjectCandidate({
      workspaceId: worktree.id,
      source: 'worktree',
      path: worktree.path,
      hostKey: resolveCandidateHostId(
        worktree.hostId,
        setup?.hostId,
        repo ? getRepoExecutionHostId(repo) : null
      ),
      projectId: owners.projectId(worktree) ?? null,
      repoId: worktree.repoId
    })
    candidates.push(candidate)
    for (const id of worktree.priorWorktreeIds ?? []) {
      const prior = splitWorktreeIdForFilesystem(id)
      if (
        prior?.repoId === worktree.repoId &&
        !occupied.has(pathKey(candidate.hostKey, prior.worktreePath))
      ) {
        candidates.push(makeProjectCandidate({ ...candidate, path: prior.worktreePath }))
      }
    }
  }

  for (const setup of projection.setups) {
    if (setup.repoId) {
      if (hasCandidatePath(setup.path)) {
        setupRepoIds.add(getRepoHostIdentityForParts(setup.repoId, getRepoExecutionHostId(setup)))
      }
    }
    if (!hasCandidatePath(setup.path)) {
      continue
    }
    candidates.push(
      makeProjectCandidate({
        source: 'setup',
        path: setup.path,
        hostKey: resolveCandidateHostId(setup.hostId, getRepoExecutionHostId(setup)),
        projectId: setup.projectId,
        repoId: setup.repoId || null
      })
    )
  }

  for (const repo of repoById.values()) {
    if (settings) {
      const hostKey = getRepoExecutionHostId(repo)
      for (const path of managedWorktreeDirectories(repo, settings)) {
        candidates.push(
          makeProjectCandidate({
            source: 'setup',
            path,
            hostKey,
            repoId: repo.id,
            projectId: owners.projectId({ repoId: repo.id, hostId: hostKey }) ?? null
          })
        )
      }
    }
    if (setupRepoIds.has(getRepoHostIdentity(repo))) {
      continue
    }
    if (!hasCandidatePath(repo.path)) {
      continue
    }
    candidates.push(
      makeProjectCandidate({
        source: 'setup',
        path: repo.path,
        hostKey: getRepoExecutionHostId(repo),
        projectId: null,
        repoId: repo.id
      })
    )
  }

  return candidates
}

function resolveSessionProject(
  session: AiVaultSession,
  candidates: readonly SessionProjectCandidate[],
  projectLabelByKey: ReadonlyMap<string, string>
): AiVaultSessionProject {
  const cwd = session.cwd
  if (!cwd) {
    return { kind: 'unknown', key: 'unknown', label: '' }
  }

  const matches = matchAiVaultProjectCandidates(
    session,
    cwd,
    candidates,
    compareAiVaultProjectCandidates
  )
  const sessionHostId = normalizeExecutionHostId(session.executionHostId)
  const hostMatches = sessionHostId
    ? matches.filter((candidate) => candidate.hostKey === sessionHostId)
    : matches
  if (sessionHostId && matches.length > 0 && hostMatches.length === 0) {
    // Why: same-path projects can exist on several hosts; a tagged transcript
    // should never be attributed to a project on a different machine.
    return aiVaultFolderProject(cwd)
  }

  const hostBuckets = new Set(hostMatches.map((candidate) => candidate.hostKey))
  if (!sessionHostId && hostBuckets.size > 1) {
    return aiVaultFolderProject(cwd)
  }

  const bestCandidate = hostMatches[0]
  if (
    !bestCandidate ||
    hostMatches.some(
      (candidate) =>
        compareAiVaultProjectCandidates(candidate, bestCandidate) === 0 &&
        toAiVaultProjectKey(candidate.projectId, candidate.repoId) !==
          toAiVaultProjectKey(bestCandidate.projectId, bestCandidate.repoId)
    )
  ) {
    return folderProject(cwd)
  }

  return aiVaultCandidateProject(bestCandidate, projectLabelByKey)
}
