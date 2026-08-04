/**
 * Regression #8873: with "Hide sleeping" on, the project's main workspace must
 * stay in the sidebar — it is the only guaranteed way back into the project —
 * while a sleeping feature workspace is still swept.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { worktreeRow } from './worktree-row-locators'

type SidebarVisibilityScenario = {
  defaultBranchId: string
  featureId: string
}

async function seedSidebarVisibilityScenario(page: Page): Promise<SidebarVisibilityScenario> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const state = store.getState()
    const repo = state.repos[0]
    if (!repo) {
      throw new Error('Sidebar visibility E2E needs a seeded repo')
    }

    const currentWorktree = (state.worktreesByRepo[repo.id] ?? [])[0]
    if (!currentWorktree) {
      throw new Error('Sidebar visibility E2E needs a seeded worktree')
    }

    const defaultBranchId = 'e2e-default-branch-visibility-main'
    const featureId = 'e2e-default-branch-visibility-feature'
    const currentId = currentWorktree.id

    store.setState((current) => ({
      worktreesByRepo: {
        ...current.worktreesByRepo,
        [repo.id]: [
          {
            ...currentWorktree,
            id: currentId,
            displayName: 'Current workspace',
            isMainWorktree: false,
            branch: 'refs/heads/current',
            lastActivityAt: 3
          },
          {
            ...currentWorktree,
            id: defaultBranchId,
            displayName: 'Default branch workspace',
            isMainWorktree: true,
            branch: 'refs/heads/main',
            lastActivityAt: 2
          },
          {
            ...currentWorktree,
            id: featureId,
            displayName: 'Feature workspace',
            isMainWorktree: false,
            branch: 'refs/heads/feature',
            lastActivityAt: 1
          }
        ]
      },
      tabsByWorktree: {
        ...current.tabsByWorktree,
        [defaultBranchId]: [],
        [featureId]: []
      },
      browserTabsByWorktree: {
        ...current.browserTabsByWorktree,
        [defaultBranchId]: [],
        [featureId]: []
      }
    }))

    const nextState = store.getState()
    nextState.setActiveView('terminal')
    nextState.setSidebarOpen(true)
    nextState.setGroupBy('none')
    nextState.setSortBy('recent')
    nextState.setShowActiveOnly(false)
    nextState.setFilterRepoIds([])

    return { defaultBranchId, featureId }
  })
}

test.describe('Default branch visibility', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('keeps the default branch visible when sleeping workspaces are hidden', async ({
    orcaPage
  }) => {
    const { defaultBranchId, featureId } = await seedSidebarVisibilityScenario(orcaPage)
    const defaultBranchRow = worktreeRow(orcaPage, defaultBranchId)
    const featureRow = worktreeRow(orcaPage, featureId)

    // Poll rather than set once: hydration can land after the seed and reset the filters.
    await expect
      .poll(() =>
        orcaPage.evaluate(
          ({ defaultBranchId, featureId }) => {
            const state = window.__store?.getState()
            state?.setShowSleepingWorkspaces(false)
            state?.setHideDefaultBranchWorkspace(false)
            state?.setAlwaysShowDefaultBranchWorkspace(true)
            const featureTabs = state?.tabsByWorktree[featureId] ?? []
            return {
              alwaysShowDefaultBranchWorkspace: state?.alwaysShowDefaultBranchWorkspace ?? null,
              defaultBranchTabs: state?.tabsByWorktree[defaultBranchId]?.length ?? 0,
              featureBrowserTabs: state?.browserTabsByWorktree[featureId]?.length ?? 0,
              featureHasLivePty: featureTabs.some(
                (tab) => (state?.ptyIdsByTabId[tab.id] ?? []).length > 0
              ),
              featureTabs: featureTabs.length,
              hideDefaultBranchWorkspace: state?.hideDefaultBranchWorkspace ?? null,
              showSleepingWorkspaces: state?.showSleepingWorkspaces ?? null
            }
          },
          { defaultBranchId, featureId }
        )
      )
      .toEqual({
        alwaysShowDefaultBranchWorkspace: true,
        defaultBranchTabs: 0,
        featureBrowserTabs: 0,
        featureHasLivePty: false,
        featureTabs: 0,
        hideDefaultBranchWorkspace: false,
        showSleepingWorkspaces: false
      })

    await expect(defaultBranchRow).toBeVisible()
    await expect(defaultBranchRow).toContainText('Default branch workspace')
    await expect(featureRow).toHaveCount(0)

    // Opting out of the exemption is the only way back to the pre-#8873 sweep.
    await orcaPage.evaluate(() => {
      window.__store?.getState().setAlwaysShowDefaultBranchWorkspace(false)
    })

    await expect(defaultBranchRow).toHaveCount(0)

    await orcaPage.evaluate(() => {
      window.__store?.getState().setAlwaysShowDefaultBranchWorkspace(true)
    })

    await expect(defaultBranchRow).toBeVisible()

    // The explicit hide filter still outranks the exemption.
    await orcaPage.evaluate(() => {
      window.__store?.getState().setHideDefaultBranchWorkspace(true)
    })

    await expect(defaultBranchRow).toHaveCount(0)
  })
})
