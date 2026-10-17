import { expect, test } from './helpers/orca-app'
import {
  waitForActiveWorktree,
  waitForSessionReady,
  waitForStartupWorktreeRefresh
} from './helpers/store'

test('pop-out click destination persists and leaves the board open', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForStartupWorktreeRefresh(orcaPage)
  const originalWorktreeId = await waitForActiveWorktree(orcaPage)
  const agent = await orcaPage.evaluate((originalWorktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const target = Object.values(state.worktreesByRepo)
      .flat()
      .find((wt) => wt.id !== originalWorktreeId)
    if (!target) {
      throw new Error('Second seeded workspace unavailable')
    }
    const leafId = '00000000-0000-4000-8000-000000000001'
    const tab = state.createTab(target.id, undefined, undefined, {
      activate: false,
      initialLeafId: leafId
    })
    state.setAgentStatus(
      `${tab.id}:${leafId}`,
      { state: 'working', prompt: 'Dashboard navigation check', agentType: 'codex' },
      'Codex',
      { updatedAt: Date.now(), stateStartedAt: Date.now() },
      { tabId: tab.id, worktreeId: target.id, terminalHandle: 'dashboard-navigation' }
    )
    state.updateSettings({
      experimentalAgentDashboardPopout: true,
      experimentalAgentDashboardMode: 'popout',
      tabAutoGenerateTitle: false
    })
    return { repoId: target.repoId, worktreeId: target.id, tabId: tab.id, leafId }
  }, originalWorktreeId)

  const popoutPromise = electronApp.waitForEvent('window')
  await orcaPage.evaluate(() => window.api.dashboard.openPopout())
  const popout = await popoutPromise
  await popout.emulateMedia({ reducedMotion: 'reduce' })
  const card = popout.getByRole('button', { name: /Dashboard navigation check/ })
  await expect(card).toBeVisible()
  await card.click()
  await expect(popout.getByRole('dialog')).toBeVisible()
  await expect(
    orcaPage.locator(`[role="option"][data-worktree-id="${originalWorktreeId}"]`)
  ).toHaveAttribute('aria-current', 'page')
  await popout.screenshot({ path: testInfo.outputPath('preview-before.png') })
  await popout.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(card).not.toHaveAttribute('aria-current')

  await popout.getByRole('button', { name: 'Agent Dashboard settings' }).click()
  const openInApp = popout.getByRole('menuitemcheckbox', { name: 'Open agents in main window' })
  await openInApp.click()
  await expect(openInApp).toBeChecked()
  await popout.screenshot({ path: testInfo.outputPath('setting-after.png') })
  await popout.keyboard.press('Escape')
  await card.click()

  const selectedWorkspace = orcaPage.locator(
    `[role="option"][data-worktree-id="${agent.worktreeId}"]`
  )
  const selectedTab = orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${agent.tabId}"]`)
  const terminal = orcaPage.locator(
    `[data-terminal-tab-id="${agent.tabId}"] [data-leaf-id="${agent.leafId}"] .xterm-screen`
  )
  await expect(selectedWorkspace).toHaveAttribute('aria-current', 'page')
  await expect(selectedTab).toHaveAttribute('data-active', 'true')
  await expect(terminal).toBeVisible()
  await expect(popout.getByRole('dialog')).toHaveCount(0)
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('aria-current', 'true')
  await popout.screenshot({ path: testInfo.outputPath('dashboard-after.png') })
  await orcaPage.screenshot({ path: testInfo.outputPath('main-window-after.png') })

  // Exercise a reveal already in flight when its workspace leaves the catalog.
  const revealReceived = orcaPage.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const off = window.api.dashboard.onRevealAgent((args) => {
          if (args.worktreeId === 'deleted-workspace') {
            off()
            resolve()
          }
        })
      })
  )
  await popout.evaluate(
    (agent) =>
      window.api.dashboard.revealAgent({
        repoId: agent.repoId,
        worktreeId: 'deleted-workspace',
        tabId: 'deleted-tab',
        leafId: null
      }),
    agent
  )
  await revealReceived
  await expect(selectedWorkspace).toHaveAttribute('aria-current', 'page')
  await expect(selectedTab).toHaveAttribute('data-active', 'true')
  await expect(terminal).toBeVisible()
  await expect(popout.getByRole('dialog')).toHaveCount(0)
  await expect(card).toHaveAttribute('aria-current', 'true')
  await orcaPage.locator(`[role="option"][data-worktree-id="${originalWorktreeId}"]`).click()
  await expect(card).not.toHaveAttribute('aria-current')
  await card.click()
  await expect(card).toHaveAttribute('aria-current', 'true')
  await expect(selectedTab).toHaveAttribute('data-active', 'true')
  await expect(terminal).toBeVisible()
  await orcaPage.evaluate((agent) => {
    window.__store
      ?.getState()
      .setAgentStatus(
        `${agent.tabId}:${agent.leafId}`,
        { state: 'waiting', prompt: 'Dashboard navigation check', agentType: 'codex' },
        'Codex',
        { updatedAt: Date.now(), stateStartedAt: Date.now() },
        { tabId: agent.tabId, worktreeId: agent.worktreeId, terminalHandle: 'dashboard-navigation' }
      )
  }, agent)
  await expect(
    popout
      .getByRole('region', { name: 'Needs You' })
      .getByRole('button', { name: /Dashboard navigation check/ })
  ).toHaveAttribute('aria-current', 'true')
  await popout.screenshot({ path: testInfo.outputPath('selected-agent-after.png') })
})
