/**
 * Regression #8873: with "Hide sleeping" on, the project's main workspace must
 * stay in the sidebar — it is the only guaranteed way back into the project —
 * while a sleeping feature workspace is still swept.
 */

import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { addRepoWithWorkspaces, writeWorkspaceMeta } from './helpers/repo-with-workspaces'
import { waitForSessionReady } from './helpers/store'
import { worktreeRow } from './worktree-row-locators'

type SidebarVisibilityScenario = {
  defaultBranchId: string
  featureId: string
}

async function seedSidebarVisibilityScenario(
  page: Page,
  testInfo: TestInfo
): Promise<SidebarVisibilityScenario> {
  // The repo's own checkout is its default branch workspace.
  const repo = await addRepoWithWorkspaces(page, testInfo, 2)
  const [currentId, featureId] = repo.ids
  await writeWorkspaceMeta(page, [
    { worktreeId: currentId!, updates: { displayName: 'Current workspace', lastActivityAt: 3 } },
    {
      worktreeId: repo.mainId,
      updates: { displayName: 'Default branch workspace', lastActivityAt: 2 }
    },
    { worktreeId: featureId!, updates: { displayName: 'Feature workspace', lastActivityAt: 1 } }
  ])
  await page.evaluate((currentId) => {
    const state = window.__store!.getState()
    state.setActiveWorktree(currentId)
    state.setActiveView('terminal')
    state.setSidebarOpen(true)
    state.setGroupBy('none')
    state.setSortBy('recent')
    state.setShowActiveOnly(false)
    state.setFilterRepoIds([])
  }, currentId!)
  return { defaultBranchId: repo.mainId, featureId: featureId! }
}

test.use({ seedTestRepo: false })

test.describe('Default branch visibility', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('keeps the default branch visible when sleeping workspaces are hidden', async ({
    orcaPage
  }, testInfo) => {
    const { defaultBranchId, featureId } = await seedSidebarVisibilityScenario(orcaPage, testInfo)
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
