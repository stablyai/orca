import { getExecutionHostLabel } from '../../../../shared/execution-host'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { DetectedWorktree, Worktree } from '../../../../shared/worktree/types'

export const LOCAL_HOST_LABEL = getExecutionHostLabel('local')

export const repo: Repo = {
  id: 'repo-1',
  path: '/tmp/orca',
  displayName: 'orca',
  badgeColor: '#000000',
  addedAt: 0
}

export const worktree: Worktree = {
  id: 'wt-1',
  repoId: repo.id,
  path: '/tmp/orca-feature',
  branch: 'refs/heads/feature/super-critical',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  comment: '',
  isUnread: false,
  isPinned: false,
  displayName: 'feature/super-critical',
  sortOrder: 0,
  lastActivityAt: 0
}

export const repoMap = new Map([[repo.id, repo]])

export const remoteRepo: Repo = {
  id: 'repo-remote',
  path: '/home/alice/orca',
  displayName: 'orca',
  badgeColor: '#111111',
  addedAt: 1,
  connectionId: 'gpu-vm'
}

export const remoteWorktree: Worktree = {
  ...worktree,
  id: 'wt-remote',
  repoId: remoteRepo.id,
  path: '/home/alice/orca-feature',
  displayName: 'remote feature'
}

export const project: Project = {
  id: 'github:stablyai/orca',
  displayName: 'Orca',
  badgeColor: '#737373',
  sourceRepoIds: [repo.id, remoteRepo.id],
  createdAt: 1,
  updatedAt: 1
}

export const projectHostSetups: ProjectHostSetup[] = [
  {
    id: repo.id,
    projectId: project.id,
    hostId: 'local',
    repoId: repo.id,
    path: repo.path,
    displayName: repo.displayName,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  },
  {
    id: remoteRepo.id,
    projectId: project.id,
    hostId: 'ssh:gpu-vm',
    repoId: remoteRepo.id,
    path: remoteRepo.path,
    displayName: remoteRepo.displayName,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }
]

export function makeDetectedWorktree(overrides: Partial<DetectedWorktree> = {}): DetectedWorktree {
  return {
    ...worktree,
    id: overrides.id ?? `${repo.id}::/tmp/${overrides.displayName ?? 'hidden'}`,
    path: overrides.path ?? `/tmp/${overrides.displayName ?? 'hidden'}`,
    displayName: overrides.displayName ?? 'hidden',
    visible: false,
    selectedCheckout: false,
    ownership: 'external',
    ...overrides
  }
}
