import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { ProjectHostSetupProjection } from '../../../../shared/project-host-setup-projection'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { ProjectHostSetup, Repo, Worktree } from '../../../../shared/types'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison,
  normalizeRuntimePathSeparators
} from '../../../../shared/cross-platform-path'

export type AiVaultSessionProject = {
  kind: 'repo' | 'folder' | 'unknown'
  key: string
  label: string
  projectId?: string
  repoId?: string
  hostKey?: ExecutionHostId
}

export type AiVaultProjectContext = {
  activeProjectKey: string | null
  activeRepoId: string | null
  projectLabelByKey: Map<string, string>
  sessionProjectById: Map<string, AiVaultSessionProject>
}

type SessionProjectCandidate = {
  source: 'worktree' | 'setup'
  normalizedPath: string
  hostKey: ExecutionHostId
  projectId: string | null
  repoId: string | null
}

type ProjectResolverArgs = {
  repos: readonly Repo[]
  worktrees: readonly Worktree[]
  projectHostSetupProjection: ProjectHostSetupProjection
  activeRepo: Repo | null
  activeWorktree: Worktree | null
  sessions: readonly AiVaultSession[]
}

export function buildAiVaultProjectContext({
  repos,
  worktrees,
  projectHostSetupProjection,
  activeRepo,
  activeWorktree,
  sessions
}: ProjectResolverArgs): AiVaultProjectContext {
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  const setupByRepoId = buildSetupByRepoId(projectHostSetupProjection.setups)
  const projectLabelByKey = buildProjectLabelByKey(repos, projectHostSetupProjection)
  const candidates = buildProjectCandidates(
    worktrees,
    projectHostSetupProjection,
    repoById,
    setupByRepoId
  )
  const sessionProjectById = new Map<string, AiVaultSessionProject>()

  for (const session of sessions) {
    sessionProjectById.set(
      session.id,
      resolveSessionProject(session, candidates, projectLabelByKey)
    )
  }

  return {
    activeProjectKey: resolveActiveProjectKey(activeRepo, activeWorktree, setupByRepoId),
    activeRepoId: activeRepo?.id ?? activeWorktree?.repoId ?? null,
    projectLabelByKey,
    sessionProjectById
  }
}

export function toAiVaultProjectKey(
  projectId: string | null | undefined,
  repoId?: string | null
): string | null {
  if (projectId) {
    // Why: legacy projections can already use repo-prefixed project ids; wrapping
    // them again would split active scope and resolved session keys.
    return projectId.startsWith('repo:') ? projectId : `project:${projectId}`
  }
  return repoId ? `repo:${repoId}` : null
}

function buildSetupByRepoId(
  setups: readonly ProjectHostSetup[]
): ReadonlyMap<string, ProjectHostSetup> {
  const setupByRepoId = new Map<string, ProjectHostSetup>()
  for (const setup of setups) {
    if (setup.repoId && !setupByRepoId.has(setup.repoId)) {
      setupByRepoId.set(setup.repoId, setup)
    }
  }
  return setupByRepoId
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
  setupByRepoId: ReadonlyMap<string, ProjectHostSetup>
): SessionProjectCandidate[] {
  const candidates: SessionProjectCandidate[] = []
  const setupRepoIds = new Set<string>()

  for (const worktree of worktrees) {
    if (!hasCandidatePath(worktree.path)) {
      continue
    }
    const repo = repoById.get(worktree.repoId)
    const setup = setupByRepoId.get(worktree.repoId)
    candidates.push({
      source: 'worktree',
      normalizedPath: normalizeRuntimePathForComparison(worktree.path),
      hostKey: resolveCandidateHostId(
        worktree.hostId,
        setup?.hostId,
        repo ? getRepoExecutionHostId(repo) : null
      ),
      projectId: worktree.projectId ?? setup?.projectId ?? null,
      repoId: worktree.repoId
    })
  }

  for (const setup of projection.setups) {
    if (setup.repoId) {
      if (hasCandidatePath(setup.path)) {
        setupRepoIds.add(setup.repoId)
      }
    }
    if (!hasCandidatePath(setup.path)) {
      continue
    }
    candidates.push({
      source: 'setup',
      normalizedPath: normalizeRuntimePathForComparison(setup.path),
      hostKey: resolveCandidateHostId(setup.hostId, getRepoExecutionHostId(setup)),
      projectId: setup.projectId,
      repoId: setup.repoId || null
    })
  }

  for (const repo of repoById.values()) {
    if (setupRepoIds.has(repo.id)) {
      continue
    }
    if (!hasCandidatePath(repo.path)) {
      continue
    }
    candidates.push({
      source: 'setup',
      normalizedPath: normalizeRuntimePathForComparison(repo.path),
      hostKey: getRepoExecutionHostId(repo),
      projectId: null,
      repoId: repo.id
    })
  }

  return candidates
}

function resolveCandidateHostId(
  ...values: readonly (string | null | undefined)[]
): ExecutionHostId {
  for (const value of values) {
    const hostId = normalizeExecutionHostId(value)
    if (hostId) {
      return hostId
    }
  }
  return LOCAL_EXECUTION_HOST_ID
}

function hasCandidatePath(pathValue: string): boolean {
  return pathValue.trim().length > 0
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

  const matches = candidates.filter((candidate) =>
    isPathInsideOrEqual(candidate.normalizedPath, cwd)
  )
  const sessionHostId = normalizeExecutionHostId(session.executionHostId)
  const hostMatches = sessionHostId
    ? matches.filter((candidate) => candidate.hostKey === sessionHostId)
    : matches
  if (sessionHostId && matches.length > 0 && hostMatches.length === 0) {
    // Why: same-path projects can exist on several hosts; a tagged transcript
    // should never be attributed to a project on a different machine.
    return folderProject(cwd)
  }

  const hostBuckets = new Set(hostMatches.map((candidate) => candidate.hostKey))
  if (!sessionHostId && hostBuckets.size > 1) {
    return folderProject(cwd)
  }

  const bestCandidate = hostMatches.sort(compareCandidates)[0]
  if (!bestCandidate) {
    return folderProject(cwd)
  }

  const key = toAiVaultProjectKey(bestCandidate.projectId, bestCandidate.repoId)
  if (!key) {
    return folderProject(cwd)
  }

  return {
    kind: 'repo',
    key,
    label: projectLabelByKey.get(key) ?? key,
    ...(bestCandidate.projectId ? { projectId: bestCandidate.projectId } : {}),
    ...(bestCandidate.repoId ? { repoId: bestCandidate.repoId } : {}),
    hostKey: bestCandidate.hostKey
  }
}

function compareCandidates(left: SessionProjectCandidate, right: SessionProjectCandidate): number {
  const lengthDifference = right.normalizedPath.length - left.normalizedPath.length
  if (lengthDifference !== 0) {
    return lengthDifference
  }
  if (left.source === right.source) {
    return 0
  }
  return left.source === 'worktree' ? -1 : 1
}

function folderProject(cwd: string): AiVaultSessionProject {
  const normalizedPath = normalizeRuntimePathForComparison(cwd)
  return {
    kind: 'folder',
    key: `folder:${normalizedPath}`,
    label: compactFolderLabel(cwd)
  }
}

function compactFolderLabel(pathValue: string): string {
  const parts = normalizeRuntimePathSeparators(pathValue).split('/').filter(Boolean)
  if (parts.length >= 2) {
    return parts.slice(-2).join('/')
  }
  return parts[0] ?? pathValue
}

function resolveActiveProjectKey(
  activeRepo: Repo | null,
  activeWorktree: Worktree | null,
  setupByRepoId: ReadonlyMap<string, ProjectHostSetup>
): string | null {
  if (activeWorktree?.projectId) {
    return toAiVaultProjectKey(activeWorktree.projectId, activeWorktree.repoId)
  }

  const setup =
    (activeRepo ? setupByRepoId.get(activeRepo.id) : null) ??
    (activeWorktree ? setupByRepoId.get(activeWorktree.repoId) : null)
  if (setup) {
    return toAiVaultProjectKey(setup.projectId, setup.repoId || activeRepo?.id)
  }

  return toAiVaultProjectKey(null, activeRepo?.id ?? activeWorktree?.repoId ?? null)
}
