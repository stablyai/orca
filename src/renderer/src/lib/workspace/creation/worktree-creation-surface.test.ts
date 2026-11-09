import { expect, it } from 'vitest'
import type { PendingWorktreeCreation, WorktreeCreationRequest } from './pending-worktree-creation'
import { selectVmBuildSurfaceShown } from './worktree-creation-surface'

function request(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
  return {
    repoId: 'r',
    name: 'fix-login',
    setupDecision: 'skip',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null,
    ...overrides
  }
}

function state(entry: Partial<PendingWorktreeCreation>) {
  const pending: PendingWorktreeCreation = {
    creationId: 'c1',
    phase: 'provisioning-vm',
    status: 'creating',
    startedAt: 0,
    indeterminate: false,
    loaderVisible: true,
    request: request(),
    ...entry
  }
  return {
    activeView: 'terminal' as const,
    activePendingCreationId: 'c1',
    pendingWorktreeCreations: { c1: pending }
  }
}

// The right sidebar closes while this is true, so a cloud build never sits beside an empty panel.
it('treats every Orca Cloud or VM build sheet as filling the window, from the first frame', () => {
  const cloud = {
    request: request({
      ephemeralVmRecipe: {
        sourceRepoId: 'r',
        recipeId: 'cloud',
        projectId: 'p',
        provider: 'orca-cloud'
      }
    })
  }
  expect(selectVmBuildSurfaceShown(state({ ...cloud, phase: 'provisioning-vm' }))).toBe(true)
  expect(
    selectVmBuildSurfaceShown(state({ ...cloud, status: 'error', loaderVisible: false }))
  ).toBe(true)
  const local = { request: request() }
  expect(selectVmBuildSurfaceShown(state(local))).toBe(false)
})
