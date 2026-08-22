import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { worktreeRow } from './worktree-row-locators'

async function seedAdjacentProject(page: Page): Promise<{ sourceId: string; targetId: string }> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is unavailable')
    }
    const state = store.getState()
    const sourceRepo = state.repos[0]
    const sourceWorktree = sourceRepo
      ? (state.worktreesByRepo[sourceRepo.id] ?? []).find((worktree) => !worktree.isArchived)
      : null
    if (!sourceRepo || !sourceWorktree) {
      throw new Error('Project cycle E2E needs the seeded local repository')
    }

    const token = crypto.randomUUID()
    const targetRepoId = `e2e-project-cycle-repo-${token}`
    const targetWorktreeId = `e2e-project-cycle-worktree-${token}`
    const targetRepo = {
      ...sourceRepo,
      id: targetRepoId,
      displayName: 'Adjacent E2E Project',
      upstream: undefined,
      repoIcon: null,
      gitRemoteIdentity: null,
      executionHostId: 'local' as const,
      connectionId: null
    }
    const targetWorktree = {
      ...sourceWorktree,
      id: targetWorktreeId,
      repoId: targetRepoId,
      displayName: 'Adjacent E2E Workspace',
      title: 'Adjacent E2E Workspace',
      branch: 'refs/heads/e2e-project-cycle',
      isMainWorktree: true,
      isArchived: false,
      hostId: 'local' as const
    }

    store.setState({
      repos: [sourceRepo, targetRepo],
      worktreesByRepo: {
        [sourceRepo.id]: [sourceWorktree],
        [targetRepoId]: [targetWorktree]
      }
    })
    const next = store.getState()
    next.setActiveView('terminal')
    next.setSidebarOpen(true)
    next.setGroupBy('repo')
    next.setShowActiveOnly(false)
    next.setShowSleepingWorkspaces(true)
    next.setHideDefaultBranchWorkspace(false)
    next.setFilterRepoIds([sourceRepo.id])
    next.setActiveRepo(sourceRepo.id)
    next.setActiveWorktree(sourceWorktree.id, 'local')
    return { sourceId: sourceWorktree.id, targetId: targetWorktreeId }
  })
}

test.describe('Project cycle shortcuts', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('moves to adjacent projects, wraps, and reveals filtered targets', async ({ orcaPage }) => {
    const { sourceId, targetId } = await seedAdjacentProject(orcaPage)
    const sourceRow = worktreeRow(orcaPage, sourceId)
    const targetRow = worktreeRow(orcaPage, targetId)
    const primaryModifier = process.platform === 'darwin' ? 'Meta' : 'Control'

    await expect(sourceRow).toHaveAttribute('aria-current', 'page')
    await expect(targetRow).toHaveCount(0)

    await orcaPage.keyboard.press(`${primaryModifier}+Shift+ArrowRight`)
    await expect(targetRow).toHaveAttribute('aria-current', 'page')

    await orcaPage.keyboard.press(`${primaryModifier}+Shift+ArrowLeft`)
    await expect(sourceRow).toHaveAttribute('aria-current', 'page')
  })
})
