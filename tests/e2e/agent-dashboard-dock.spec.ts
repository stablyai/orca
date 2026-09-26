import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('docks the existing board above the workspace and keeps the terminal width', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.setViewportSize({ width: 1280, height: 900 })
  await orcaPage.evaluate(() => window.__store!.getState().updateSettings({ uiLanguage: 'en' }))
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate(async (id) => {
    const store = window.__store!
    const state = store.getState()
    const tab = state.tabsByWorktree[id][0]
    await state.updateSettings({
      experimentalAgentDashboardPopout: true,
      experimentalAgentDashboardMode: 'in-window',
      experimentalAgentDashboardDocked: false,
      theme: 'light'
    })
    store.setState({ agentDashboardDrawerOpen: false })
    state.setAgentStatus(
      `${tab.id}:00000000-0000-4000-8000-000000000001`,
      {
        state: 'working',
        prompt: 'Keep the agent board visible while working',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: Date.now(), stateStartedAt: Date.now() },
      {
        tabId: tab.id,
        terminalHandle: 'dashboard-dock-preview',
        worktreeId: id
      }
    )
  }, worktreeId)

  const workbench = orcaPage.locator('[data-terminal-workbench-container]')
  const initialBounds = await workbench.boundingBox()
  await orcaPage.getByRole('button', { name: /Agent Dashboard/ }).click()
  const sheet = orcaPage.locator('[data-agent-dashboard-sheet]')
  await expect(sheet.getByRole('heading', { name: 'Agents', exact: true, level: 1 })).toBeVisible()
  await expect
    .poll(async () => Math.round((await sheet.boundingBox())?.x ?? -1))
    .toBe(Math.round(initialBounds!.x))
  await testInfo.attach('before-sidebar-board', {
    body: await orcaPage.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('before-sidebar-board.png')
    }),
    contentType: 'image/png'
  })
  await orcaPage.getByRole('button', { name: 'Agent Dashboard settings' }).click()
  await orcaPage.getByRole('switch', { name: 'Dock above workspace' }).click()

  const dock = orcaPage.getByRole('region', { name: 'Docked Agent Dashboard' })
  await expect(dock).toBeVisible()
  await expect(orcaPage.locator('[data-agent-dashboard-sheet]')).toHaveCount(0)
  await expect(dock.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
  await expect(dock).toContainText('Keep the agent board visible while working')
  await expect.poll(async () => (await workbench.boundingBox())?.width).toBe(initialBounds?.width)
  const dockBounds = await dock.boundingBox()
  const terminalBounds = await workbench.boundingBox()
  expect(terminalBounds!.y).toBeGreaterThanOrEqual(dockBounds!.y + dockBounds!.height)
  await workbench.click({ position: { x: 40, y: 90 } })
  await orcaPage.keyboard.press('Escape')
  await expect(dock).toBeVisible()
  await testInfo.attach('after-docked-board', {
    body: await orcaPage.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('after-docked-board.png')
    }),
    contentType: 'image/png'
  })

  await orcaPage.getByRole('button', { name: 'Toggle sidebar', exact: true }).click()
  await expect(dock).toBeVisible()
  await expect
    .poll(async () => (await workbench.boundingBox())?.width ?? 0)
    .toBeGreaterThan(initialBounds!.width)
  await expect
    .poll(() =>
      workbench.evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--collapsed-sidebar-header-width').trim()
      )
    )
    .toBe('0px')
  await testInfo.attach('after-sidebar-closed', {
    body: await orcaPage.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('after-sidebar-closed.png')
    }),
    contentType: 'image/png'
  })

  await orcaPage.evaluate(() => window.__store!.getState().updateSettings({ theme: 'dark' }))
  await expect(orcaPage.locator('html')).toHaveClass(/dark/)
  await testInfo.attach('after-dark', {
    body: await orcaPage.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('after-dark.png')
    }),
    contentType: 'image/png'
  })
  await orcaPage.setViewportSize({ width: 900, height: 700 })
  await expect(dock).toBeVisible()
  await expect.poll(async () => (await workbench.boundingBox())?.height ?? 0).toBeGreaterThan(250)
  await testInfo.attach('after-narrow', {
    body: await orcaPage.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('after-narrow.png')
    }),
    contentType: 'image/png'
  })

  const search = dock.getByPlaceholder('Search worktree, project, or agent…')
  await search.fill('agent')
  // Simulate delayed host status delivery while the user is typing in the board.
  await orcaPage.evaluate(async (id) => {
    await new Promise((resolve) => setTimeout(resolve, 150))
    const state = window.__store!.getState()
    const tab = state.tabsByWorktree[id][0]
    state.setAgentStatus(
      `${tab.id}:00000000-0000-4000-8000-000000000001`,
      {
        state: 'working',
        prompt: 'Keep the agent board visible during delayed updates',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: Date.now(), stateStartedAt: Date.now() },
      { tabId: tab.id, terminalHandle: 'dashboard-dock-preview', worktreeId: id }
    )
  }, worktreeId)
  await expect(dock).toContainText('Keep the agent board visible during delayed updates')
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('agent')
  await search.clear()

  await dock.getByRole('button', { name: 'Agent Dashboard settings' }).click()
  await testInfo.attach('dock-settings', {
    body: await orcaPage.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('dock-settings.png')
    }),
    contentType: 'image/png'
  })
  await orcaPage.getByRole('switch', { name: 'Dock above workspace' }).press('Space')
  await expect(dock).toHaveCount(0)
  await expect(orcaPage.locator('[data-agent-dashboard-sheet]')).toBeVisible()
})

test('restores the dashboard across full-page navigation and undocking in settings', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.setViewportSize({ width: 1280, height: 900 })
  await orcaPage.evaluate(async () => {
    const store = window.__store!
    await store.getState().updateSettings({
      uiLanguage: 'en',
      experimentalAgentDashboardPopout: true,
      experimentalAgentDashboardMode: 'in-window',
      experimentalAgentDashboardDocked: true
    })
    store.setState({ agentDashboardDrawerOpen: true, sidebarOpen: false })
  })

  const dock = orcaPage.getByRole('region', { name: 'Docked Agent Dashboard' })
  await expect(dock).toBeVisible()
  for (const view of ['activity', 'space'] as const) {
    await orcaPage.evaluate((next) => {
      const state = window.__store!.getState()
      if (next === 'activity') {
        state.openActivityPage()
      } else {
        state.openSpacePage()
      }
    }, view)
    await expect(dock).toHaveCount(0)
    await expect(orcaPage.locator('[data-terminal-workbench-container]')).toBeHidden()
    await orcaPage.screenshot({
      path: testInfo.outputPath(`${view}-without-dock.png`),
      animations: 'disabled'
    })
    await orcaPage.evaluate((previous) => {
      const state = window.__store!.getState()
      if (previous === 'activity') {
        state.closeActivityPage()
      } else {
        state.closeSpacePage()
      }
    }, view)
    await expect(dock).toBeVisible()
  }

  await orcaPage.evaluate(() => window.__store!.getState().openSettingsPage())
  await expect(dock).toHaveCount(0)
  await orcaPage.getByPlaceholder('Search settings').fill('Dock above workspace')
  const toggle = orcaPage.getByRole('switch', { name: 'Dock above workspace' })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await orcaPage.getByRole('button', { name: 'Back to app', exact: true }).click()
  await expect(dock).toHaveCount(0)
  const sheet = orcaPage.locator('[data-agent-dashboard-sheet]')
  await expect(sheet.getByRole('heading', { name: 'Agents', exact: true, level: 1 })).toBeVisible()
  await orcaPage.screenshot({
    path: testInfo.outputPath('sidebar-restored-from-settings.png'),
    animations: 'disabled'
  })
})
