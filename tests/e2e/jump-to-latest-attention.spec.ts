import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady, ensureTerminalVisible } from './helpers/store'
import {
  focusActiveTerminalInput,
  splitActiveTerminalPane,
  waitForPaneCount,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { pressShortcut } from './helpers/shortcuts'

test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

test('latest input request shortcut opens the exact split pane and keeps the request pending', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  // Isolated Electron profile setup and teardown can dominate this keyboard journey on loaded hosts.
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate(async () => {
    const state = window.__store!.getState()
    await state.updateSettings({ uiLanguage: 'en' })
    state.setAgentActivityDisplayMode('full')
    if (!state.worktreeCardProperties.includes('inline-agents')) {
      state.setWorktreeCardProperties([...state.worktreeCardProperties, 'inline-agents'])
    }
  })
  await ensureTerminalVisible(orcaPage)
  const worktrees = await orcaPage.evaluate(() =>
    Object.values(window.__store!.getState().worktreesByRepo)
      .flat()
      .filter((wt) => !wt.isArchived)
      .map((wt) => wt.id)
  )
  const [firstId, targetId] = worktrees
  if (!firstId || !targetId) {
    throw new Error('Expected two synthetic workspaces')
  }
  const targetRow = orcaPage
    .locator(
      `[data-worktree-sidebar] [role="option"][data-worktree-id=${JSON.stringify(targetId)}]`
    )
    .first()
  const firstRow = orcaPage
    .locator(`[data-worktree-sidebar] [role="option"][data-worktree-id=${JSON.stringify(firstId)}]`)
    .first()
  await targetRow.click()
  await ensureTerminalVisible(orcaPage)
  await splitActiveTerminalPane(orcaPage, 'horizontal')
  await waitForPaneCount(orcaPage, 2)
  const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 2)
  const [olderPane, latestPane] = snapshot.panes
  if (!olderPane || !latestPane) {
    throw new Error('Expected stable split pane identities')
  }
  await orcaPage.clock.setFixedTime(new Date('2026-01-01T12:00:00Z'))
  await orcaPage.evaluate(
    ({ tabId, olderLeaf, latestLeaf }) => {
      const store = window.__store!
      const state = store.getState()
      const now = Date.now()
      state.setAgentStatus(
        `${tabId}:${olderLeaf}`,
        { state: 'blocked', prompt: 'Older synthetic request', agentType: 'codex' },
        'Older synthetic agent',
        { updatedAt: now, stateStartedAt: now - 2_000 }
      )
      state.setAgentStatus(
        `${tabId}:${latestLeaf}`,
        { state: 'waiting', prompt: 'Latest synthetic request', agentType: 'codex' },
        'Latest synthetic agent',
        { updatedAt: now, stateStartedAt: now - 1_000 }
      )
    },
    { tabId: snapshot.tabId, olderLeaf: olderPane.leafId, latestLeaf: latestPane.leafId }
  )
  await firstRow.click()
  await ensureTerminalVisible(orcaPage)
  await focusActiveTerminalInput(orcaPage)
  await expect(firstRow).toHaveAttribute('aria-current', 'page')
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().disableKeybindingAction('worktree.jumpToLatestAttention')
  })
  await pressShortcut(orcaPage, 'KeyU', { shift: true })
  await expect(firstRow).toHaveAttribute('aria-current', 'page')
  const sidebar = await orcaPage.locator('[data-worktree-sidebar]').boundingBox()
  if (!sidebar) {
    throw new Error('Expected visible workspace sidebar')
  }
  const clip = {
    x: sidebar.x,
    y: sidebar.y,
    width: sidebar.width,
    height: Math.min(650, sidebar.height)
  }
  const before = testInfo.outputPath('latest-attention-before.png')
  await orcaPage.screenshot({ path: before, clip })
  await testInfo.attach('before', { path: before, contentType: 'image/png' })

  await orcaPage.evaluate(async () => {
    await window.__store!.getState().resetKeybindingOverride('worktree.jumpToLatestAttention')
  })

  await pressShortcut(orcaPage, 'KeyU', { shift: true })
  await expect(targetRow).toHaveAttribute('aria-current', 'page')
  const latestInput = orcaPage.locator(
    `[data-terminal-tab-id=${JSON.stringify(snapshot.tabId)}] [data-leaf-id=${JSON.stringify(latestPane.leafId)}] .xterm-helper-textarea`
  )
  await expect(latestInput).toBeFocused()
  await expect(targetRow.getByLabel('Waiting for input', { exact: true }).first()).toBeVisible()
  await expect(targetRow.getByLabel('Blocked', { exact: true }).first()).toBeVisible()
  const after = testInfo.outputPath('latest-attention-after.png')
  await orcaPage.screenshot({ path: after, clip })
  await testInfo.attach('after', { path: after, contentType: 'image/png' })
  await pressShortcut(orcaPage, 'KeyU', { shift: true })
  await expect(latestInput).toBeFocused()
  await expect(targetRow).toHaveAttribute('aria-current', 'page')
  await expect(targetRow.getByLabel('Waiting for input', { exact: true }).first()).toBeVisible()
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
