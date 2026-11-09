import { expect, it } from 'vitest'
import type { PendingWorktreeCreation } from './pending-worktree-creation'
import { selectVmBuildSurfaceShown } from './worktree-creation-surface'

function state(entry: Partial<PendingWorktreeCreation>) {
  return {
    activeView: 'terminal' as const,
    activePendingCreationId: 'c1',
    pendingWorktreeCreations: {
      c1: { status: 'creating', loaderVisible: true, ...entry } as PendingWorktreeCreation
    }
  }
}

// The right sidebar closes while this is true, so a cloud build never sits beside an empty panel.
it('treats every Orca Cloud or VM build sheet as filling the window, from the first frame', () => {
  const cloud = {
    request: {
      name: 'fix-login',
      ephemeralVmRecipe: {
        sourceRepoId: 'r',
        recipeId: 'cloud',
        projectId: 'p',
        provider: 'orca-cloud'
      }
    } as PendingWorktreeCreation['request']
  }
  expect(selectVmBuildSurfaceShown(state({ ...cloud, phase: 'provisioning-vm' }))).toBe(true)
  expect(
    selectVmBuildSurfaceShown(state({ ...cloud, status: 'error', loaderVisible: false }))
  ).toBe(true)
  const local = { request: { name: 'fix-login' } as PendingWorktreeCreation['request'] }
  expect(selectVmBuildSurfaceShown(state(local))).toBe(false)
})
