import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getAllWorktreeIds, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

async function sendNextAttentionShortcut(electronApp: ElectronApplication): Promise<void> {
  // Why IPC, not keys: the command ships unbound; chord resolution is covered by unit tests.
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('ui:jumpToNextAttention')
    }
  })
}

async function showFlatSidebar(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('window.__store is not available')
    }
    state.setActiveView('terminal')
    state.setSidebarOpen(true)
    state.setGroupBy('none')
    state.setShowSleepingWorkspaces(true)
    state.setFilterRepoIds([])
  })
}

test.describe('Go to next workspace needing attention', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await showFlatSidebar(orcaPage)
  })

  test('switches to a workspace the user marked unread', async ({ orcaPage, electronApp }) => {
    const activeId = await waitForActiveWorktree(orcaPage)
    const targetId = (await getAllWorktreeIds(orcaPage)).find((id) => id !== activeId)
    expect(targetId).toBeDefined()
    await orcaPage.evaluate((id) => {
      window.__store?.getState().setWorkspaceUnreadByUser(id, true, 'local')
    }, targetId!)

    await sendNextAttentionShortcut(electronApp)

    await expect(
      orcaPage.locator(`[role="option"][data-worktree-id=${JSON.stringify(targetId)}]`)
    ).toHaveAttribute('aria-current', 'page')
  })

  test('says so and stays put when nothing needs attention', async ({ orcaPage, electronApp }) => {
    const activeId = await waitForActiveWorktree(orcaPage)
    // Why: a startup bell or agent row would make the queue non-empty and hide the toast.
    await orcaPage.evaluate(() => {
      window.__store?.setState({
        unreadTerminalTabs: {},
        unreadTerminalPanes: {},
        unreadAgentCompletionPanes: {},
        agentStatusByPaneKey: {}
      })
    })

    await sendNextAttentionShortcut(electronApp)

    await expect(
      orcaPage.locator('[data-sonner-toast]').filter({ hasText: 'No workspaces need attention' })
    ).toBeVisible()
    await expect(
      orcaPage.locator(`[role="option"][data-worktree-id=${JSON.stringify(activeId)}]`)
    ).toHaveAttribute('aria-current', 'page')
  })
})
