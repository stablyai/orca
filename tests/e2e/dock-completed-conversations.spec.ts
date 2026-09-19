import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'

test.skip(process.platform !== 'darwin', 'macOS Dock only')

test('Dock menu opens a completed conversation and preserves its unread sibling', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate(() => window.__store!.getState().updateSettings({ uiLanguage: 'en' }))
  await orcaPage.evaluate(() => {
    const store = window.__store!
    const state = store.getState()
    const worktreeId = state.activeWorktreeId!
    const now = Date.now()
    const retained = Object.fromEntries(
      ['First Dock result', 'Second Dock result'].map((title, index) => {
        const tabId = `dock-completed-${index}`
        const paneKey = `${tabId}:11111111-1111-4111-8111-111111111111`
        return [
          paneKey,
          {
            worktreeId,
            agentType: 'codex',
            startedAt: now - index,
            tab: {
              id: tabId,
              worktreeId,
              ptyId: null,
              title,
              customTitle: null,
              color: null,
              sortOrder: index,
              createdAt: now
            },
            entry: {
              paneKey,
              worktreeId,
              tabId,
              state: 'done' as const,
              agentType: 'codex',
              prompt: title,
              lastAssistantMessage: `${title}: completed output`,
              updatedAt: now - index,
              stateStartedAt: now - index,
              stateHistory: []
            }
          }
        ]
      })
    )
    state.openActivityPage()
    store.setState({
      retainedAgentsByPaneKey: retained,
      acknowledgedAgentsByPaneKey: {},
      selectedActivityPaneKey: null
    })
  })
  await expect
    .poll(() =>
      electronApp.evaluate(({ app }) => app.dock?.getMenu()?.items.map((item) => item.label))
    )
    .toEqual([
      'Completed, unread (2)',
      expect.stringContaining('First Dock result'),
      expect.stringContaining('Second Dock result')
    ])
  await orcaPage.screenshot({ path: testInfo.outputPath('before-selection.png') })
  await electronApp.evaluate(({ app, BrowserWindow }) => {
    const item = app.dock
      ?.getMenu()
      ?.items.find((candidate) => candidate.label.includes('First Dock result'))
    if (!item) {
      throw new Error('Completed conversation menu item missing')
    }
    item.click(item, BrowserWindow.getAllWindows()[0], { triggeredByAccelerator: false })
  })
  await expect(
    orcaPage.getByText('Agent terminal closed. Open a new terminal in this workspace to continue.')
  ).toBeVisible()
  await expect(orcaPage.getByText('First Dock result', { exact: true }).last()).toBeVisible()
  await expect
    .poll(() =>
      electronApp.evaluate(({ app }) => app.dock?.getMenu()?.items.map((item) => item.label))
    )
    .toEqual(['Completed, unread (1)', expect.stringContaining('Second Dock result')])
  await orcaPage.screenshot({ path: testInfo.outputPath('after-selection.png') })
})

test('Dock menu focuses the exact completed terminal split', async ({ electronApp, orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate(() => window.__store!.getState().updateSettings({ uiLanguage: 'en' }))
  await waitForActiveTerminalManager(orcaPage)
  await splitActiveTerminalPane(orcaPage, 'vertical')
  const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 2)
  const target = snapshot.panes[0]
  await orcaPage.evaluate(
    ({ tabId, leafId }) => {
      const store = window.__store!
      const state = store.getState()
      state.openActivityPage()
      const paneKey = `${tabId}:${leafId}`
      const now = Date.now()
      state.setAgentStatus(
        paneKey,
        {
          state: 'done',
          prompt: 'Exact Dock split result',
          agentType: 'codex',
          lastAssistantMessage: 'Target split finished'
        },
        'Dock split',
        { updatedAt: now, stateStartedAt: now }
      )
      store.setState({ acknowledgedAgentsByPaneKey: {}, selectedActivityPaneKey: null })
    },
    { tabId: snapshot.tabId, leafId: target.leafId }
  )
  await expect
    .poll(() =>
      electronApp.evaluate(({ app }) =>
        app.dock?.getMenu()?.items.some((item) => item.label.includes('Exact Dock split result'))
      )
    )
    .toBe(true)
  await electronApp.evaluate(({ app, BrowserWindow }) => {
    const item = app.dock
      ?.getMenu()
      ?.items.find((candidate) => candidate.label.includes('Exact Dock split result'))
    if (!item) {
      throw new Error('Completed split menu item missing')
    }
    item.click(item, BrowserWindow.getAllWindows()[0], { triggeredByAccelerator: false })
  })
  const pane = orcaPage.locator(`.pane[data-leaf-id="${target.leafId}"]`).first()
  await expect(pane).toBeVisible()
  await expect(pane.locator('.xterm-helper-textarea')).toBeFocused()
})
