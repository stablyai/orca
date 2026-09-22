import type { Automation } from '../../../../shared/automations-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

export const RUNTIME_REPO_ID = 'repo-2'
export const RUNTIME_WORKSPACE_ID = 'workspace-2'

/** Builds the host-scoped response used by the page harness. */
export function selfScopedList(automations: Automation[]): Record<string, unknown> {
  return {
    automations,
    items: automations.map((automation) => ({
      automationId: automation.id,
      selector: { kind: 'self' }
    })),
    orphanCount: 0
  }
}

type RuntimeFixtureMocks = {
  state: Record<string, unknown>
  repoMap: Map<string, unknown>
  worktreeMap: Map<string, unknown>
}

/** Adds a runtime-owned project whose id is ambiguous in a flat repo lookup. */
export function addRuntimeProject(mocks: RuntimeFixtureMocks, runtimeId: string): void {
  const repo = {
    id: RUNTIME_REPO_ID,
    displayName: 'gpu-orca',
    path: '/repos/gpu-orca',
    badgeColor: '#111111',
    addedAt: 1,
    worktreeBaseRef: 'main',
    executionHostId: `runtime:${runtimeId}`
  } as Repo
  const worktree = {
    id: RUNTIME_WORKSPACE_ID,
    repoId: RUNTIME_REPO_ID,
    displayName: 'main',
    path: '/repos/gpu-orca',
    branch: 'main'
  } as Worktree
  const setup: ProjectHostSetup = {
    id: 'setup-2',
    projectId: 'project-2',
    hostId: `runtime:${runtimeId}`,
    repoId: RUNTIME_REPO_ID,
    path: '/repos/gpu-orca',
    displayName: 'gpu-orca',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }
  const repos = mocks.state.repos as Repo[]
  const setups = mocks.state.projectHostSetups as ProjectHostSetup[]
  const worktreesByRepo = mocks.state.worktreesByRepo as Record<string, Worktree[]>
  mocks.state.repos = [...repos, repo]
  mocks.state.projectHostSetups = [...setups, setup]
  mocks.state.worktreesByRepo = { ...worktreesByRepo, [RUNTIME_REPO_ID]: [worktree] }
  mocks.repoMap.set(RUNTIME_REPO_ID, repo)
  mocks.worktreeMap.set(RUNTIME_WORKSPACE_ID, worktree)
}
