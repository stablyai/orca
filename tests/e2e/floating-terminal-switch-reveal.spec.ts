import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// Mirror FLOATING_TERMINAL_WORKTREE_ID without loading renderer/shared modules into Playwright.
const FLOATING_WORKTREE_ID = 'global-floating-terminal'
const OPEN_PANEL_SELECTOR = '[data-floating-terminal-panel][aria-hidden="false"]'

// Switching must reveal the floating panel without selecting its workspace in the main window.
test('switching to a floating terminal opens the panel and keeps the main workspace', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const mainWorktreeId = await waitForActiveWorktree(orcaPage)

  const tabId = await orcaPage.evaluate(async (worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    await store.getState().updateSettings({ floatingTerminalEnabled: true })
    store.setState({ floatingWorkspacePanelOpen: false })
    return store.getState().createTab(worktreeId, undefined, undefined, { activate: false }).id
  }, FLOATING_WORKTREE_ID)
  await expect(orcaPage.locator(OPEN_PANEL_SELECTOR)).toHaveCount(0)

  await electronApp.evaluate(
    ({ BrowserWindow }, payload) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('ui:focusTerminal', payload)
    },
    { tabId, worktreeId: FLOATING_WORKTREE_ID }
  )

  await expect(orcaPage.locator(OPEN_PANEL_SELECTOR)).toBeVisible()
  const selection = await orcaPage.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    return {
      active: state?.activeWorktreeId,
      floatingTab: state?.activeTabIdByWorktree[worktreeId]
    }
  }, FLOATING_WORKTREE_ID)
  expect(selection).toEqual({ active: mainWorktreeId, floatingTab: tabId })
})
