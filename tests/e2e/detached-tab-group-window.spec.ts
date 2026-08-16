import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { execInTerminal } from './helpers/terminal'

// Why E2E rather than a slice test: the thing under test is an actual second
// Electron window and a React portal into its document. A store test would
// assert the id list and prove nothing about a terminal rendering over there.
test('keeps two detached windows themed, shortcut-aware, and independently closable', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  await orcaPage.evaluate(() => {
    void window.__store.getState().updateSettings({ experimentalDetachedPanes: true })
  })

  const groupIds = await orcaPage.evaluate(() => {
    const state = window.__store.getState()
    const worktreeId = state.activeWorktreeId
    const firstGroupId = worktreeId ? state.groupsByWorktree[worktreeId]?.[0]?.id : undefined
    if (!worktreeId || !firstGroupId) {
      return null
    }
    const secondGroupId = state.createEmptySplitGroup(worktreeId, firstGroupId, 'right')
    if (!secondGroupId) {
      return null
    }
    state.createTab(worktreeId, secondGroupId, undefined, { activate: true })
    return [firstGroupId, secondGroupId]
  })
  expect(groupIds).not.toBeNull()

  const firstAuxPromise = electronApp.waitForEvent('window', { timeout: 30_000 })
  await orcaPage.evaluate((id) => {
    window.__store.getState().detachTabGroup(id)
  }, groupIds![0])
  const firstAux = await firstAuxPromise
  await firstAux.waitForLoadState('domcontentloaded')

  const secondAuxPromise = electronApp.waitForEvent('window', { timeout: 30_000 })
  await orcaPage.evaluate((id) => {
    window.__store.getState().detachTabGroup(id)
  }, groupIds![1])
  const secondAux = await secondAuxPromise
  await secondAux.waitForLoadState('domcontentloaded')

  for (const auxPage of [firstAux, secondAux]) {
    await expect(auxPage.locator('.xterm-screen')).toBeVisible({ timeout: 30_000 })
    expect(await auxPage.evaluate(() => document.styleSheets.length > 0)).toBe(true)
  }
  const resolveFirstAuxTerminal = () =>
    orcaPage.evaluate((groupId) => {
      const state = window.__store.getState()
      const owner = Object.entries(state.groupsByWorktree).find(([, groups]) =>
        groups.some((group) => group.id === groupId)
      )
      const group = owner?.[1].find((candidate) => candidate.id === groupId)
      const unifiedTab = owner
        ? state.unifiedTabsByWorktree[owner[0]]?.find(
            (candidate) => candidate.id === group?.activeTabId
          )
        : undefined
      const terminal = owner
        ? state.tabsByWorktree[owner[0]]?.find((candidate) => candidate.id === unifiedTab?.entityId)
        : undefined
      const ptyId = terminal?.ptyId ?? state.ptyIdsByTabId[unifiedTab?.entityId ?? '']?.[0]
      return unifiedTab?.contentType === 'terminal' && ptyId
        ? { tabId: unifiedTab.entityId, ptyId }
        : null
    }, groupIds![0])
  await expect.poll(resolveFirstAuxTerminal, { timeout: 20_000 }).not.toBeNull()
  const firstAuxTerminal = await resolveFirstAuxTerminal()
  expect(firstAuxTerminal).not.toBeNull()

  await expect(orcaPage.locator('.xterm-screen')).toHaveCount(0, { timeout: 15_000 })

  await orcaPage.evaluate(() => window.__store.getState().setSidebarOpen(true))
  await expect(orcaPage.locator('[data-worktree-sidebar]')).toBeVisible()
  await firstAux.locator('.xterm-helper-textarea:visible').focus()
  await firstAux.keyboard.press(process.platform === 'darwin' ? 'Meta+B' : 'Control+B')
  await expect(orcaPage.locator('[data-worktree-sidebar]')).toHaveCount(0)

  await orcaPage.evaluate(() => {
    void window.__store.getState().updateSettings({ theme: 'light' })
  })
  await expect
    .poll(() => firstAux.evaluate(() => document.documentElement.classList.contains('light')))
    .toBe(true)
  expect(await secondAux.evaluate(() => document.documentElement.classList.contains('light'))).toBe(
    true
  )

  const pinnedTabId = await orcaPage.evaluate((groupId) => {
    const state = window.__store.getState()
    const tabId = state.groupsByWorktree[state.activeWorktreeId!]?.find(
      (group) => group.id === groupId
    )?.activeTabId
    if (tabId) {
      state.pinTab(tabId)
    }
    return tabId ?? null
  }, groupIds![0])
  expect(pinnedTabId).not.toBeNull()
  await firstAux.locator('.xterm-helper-textarea:visible').focus()
  await firstAux.keyboard.press(process.platform === 'darwin' ? 'Meta+W' : 'Control+W')
  await expect(firstAux.getByRole('dialog')).toContainText('Close pinned tab?')
  await expect(orcaPage.getByRole('dialog')).toHaveCount(0)
  await firstAux.getByRole('button', { name: 'Cancel' }).click()
  await orcaPage.evaluate((tabId) => window.__store.getState().unpinTab(tabId), pinnedTabId!)

  const workspaceIds = await orcaPage.evaluate(async (name) => {
    const state = window.__store.getState()
    const worktreeId = state.activeWorktreeId
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((candidate) => candidate.id === worktreeId)
    if (!worktreeId || !worktree) {
      return null
    }
    const alternate = await state.createWorktree(worktree.repoId, name)
    state.setActiveWorktree(alternate.worktree.id)
    return { originalWorktreeId: worktreeId, alternateWorktreeId: alternate.worktree.id }
  }, `e2e-detached-pane-${Date.now()}`)
  expect(workspaceIds).not.toBeNull()
  await expect
    .poll(() => orcaPage.evaluate(() => window.__store.getState().activeWorktreeId))
    .toBe(workspaceIds!.alternateWorktreeId)
  await expect(firstAux.locator('.xterm-screen:visible')).toHaveCount(1)
  const originalGroupTabIds = await orcaPage.evaluate(
    ({ groupId, worktreeId }) =>
      window.__store.getState().groupsByWorktree[worktreeId]?.find((group) => group.id === groupId)
        ?.tabOrder ?? [],
    { groupId: groupIds![0], worktreeId: workspaceIds!.originalWorktreeId }
  )
  const originalAuxTabCount = await firstAux.locator('[data-testid="sortable-tab"]').count()
  await firstAux.locator('.xterm-helper-textarea:visible').focus()
  await firstAux.keyboard.press(process.platform === 'darwin' ? 'Meta+T' : 'Control+T')
  await expect(firstAux.locator('[data-testid="sortable-tab"]')).toHaveCount(
    originalAuxTabCount + 1
  )
  const findNewTabId = () =>
    orcaPage.evaluate(
      ({ groupId, previousIds }) => {
        const state = window.__store.getState()
        const group = Object.values(state.groupsByWorktree)
          .flat()
          .find((candidate) => candidate.id === groupId)
        return group?.tabOrder.find((tabId) => !previousIds.includes(tabId)) ?? null
      },
      { groupId: groupIds![0], previousIds: originalGroupTabIds }
    )
  await expect.poll(findNewTabId).not.toBeNull()
  const newTabId = await findNewTabId()
  expect(newTabId).not.toBeNull()
  await orcaPage.evaluate(() => {
    const state = window.__store.getState()
    state.openSettingsTarget({ pane: 'appearance', repoId: null })
    state.openSettingsPage()
    state.setActiveWorktree(null)
  })
  await expect(orcaPage.locator('[data-settings-section="appearance"]')).toBeVisible()
  await expect(firstAux.locator('.xterm-screen:visible')).toHaveCount(1)

  await firstAux.locator('.xterm-helper-textarea:visible').focus()
  await firstAux.keyboard.down('Control')
  await firstAux.keyboard.down('Tab')
  await expect(firstAux.getByRole('listbox', { name: 'Switch tabs' })).toBeVisible()
  await expect(orcaPage.getByRole('listbox', { name: 'Switch tabs' })).toHaveCount(0)
  await firstAux.keyboard.up('Tab')
  await firstAux.keyboard.up('Control')
  await expect(
    firstAux.locator('[data-testid="sortable-tab"][data-active="true"]')
  ).not.toHaveAttribute('data-unified-tab-id', newTabId!)

  const switchedTabId = await firstAux
    .locator('[data-testid="sortable-tab"][data-active="true"]')
    .getAttribute('data-unified-tab-id')
  expect(switchedTabId).toBe(firstAuxTerminal!.tabId)
  await orcaPage.evaluate((tabId) => window.__store.getState().pinTab(tabId), switchedTabId!)
  await firstAux.locator('.xterm-helper-textarea:visible').focus()
  await firstAux.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  )
  await firstAux.keyboard.press(process.platform === 'darwin' ? 'Meta+W' : 'Control+W')
  await expect(firstAux.getByRole('dialog')).toContainText('Close pinned tab?')
  await expect(orcaPage.getByRole('dialog')).toHaveCount(0)
  await firstAux.getByRole('button', { name: 'Cancel' }).click()
  await orcaPage.evaluate((tabId) => window.__store.getState().unpinTab(tabId), switchedTabId!)

  const mainEditorFileId = await orcaPage.evaluate((worktreeId) => {
    const state = window.__store.getState()
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((candidate) => candidate.id === worktreeId)
    if (!worktree) {
      return null
    }
    state.setActiveView('terminal')
    state.setActiveWorktree(worktreeId)
    const groupId = state.ensureWorktreeRootGroup(worktreeId)
    const separator = worktree.path.includes('\\') ? '\\' : '/'
    const filePath = `${worktree.path}${separator}package.json`
    state.openFile(
      {
        filePath,
        relativePath: 'package.json',
        worktreeId,
        language: 'json',
        mode: 'edit'
      },
      { preview: false, targetGroupId: groupId }
    )
    const fileId =
      window.__store.getState().openFiles.find((file) => file.filePath === filePath)?.id ?? null
    if (fileId) {
      state.setActiveFile(fileId)
      state.setActiveTabType('editor')
    }
    return fileId
  }, workspaceIds!.alternateWorktreeId)
  expect(mainEditorFileId).not.toBeNull()
  await expect(orcaPage.locator('.monaco-editor')).toBeVisible()

  await execInTerminal(orcaPage, firstAuxTerminal!.ptyId, 'node -e "setTimeout(()=>{},300000)"')
  await expect
    .poll(
      async () =>
        (
          await orcaPage.evaluate(
            (ptyId) => window.api.pty.inspectProcess(ptyId),
            firstAuxTerminal!.ptyId
          )
        ).foregroundProcess,
      { timeout: 20_000 }
    )
    .toMatch(/^node(?:\.exe)?$/i)
  await firstAux.locator('.xterm-helper-textarea:visible').focus()
  await firstAux.keyboard.press(process.platform === 'darwin' ? 'Meta+W' : 'Control+W')
  await expect(firstAux.getByText(/Stop running command\?|Stop this agent\?/)).toBeVisible()
  await expect(orcaPage.locator('.monaco-editor')).toBeVisible()
  await firstAux.getByRole('button', { name: 'Cancel' }).click()
  await orcaPage.evaluate((ptyId) => window.api.pty.write(ptyId, '\u0003'), firstAuxTerminal!.ptyId)

  const mainBrowserTabId = await orcaPage.evaluate((worktreeId) => {
    const state = window.__store.getState()
    const groupId = state.ensureWorktreeRootGroup(worktreeId)
    const browser = state.createBrowserTab(worktreeId, 'about:blank', {
      activate: true,
      focusAddressBar: false,
      targetGroupId: groupId
    })
    state.setActiveTabType('browser')
    return browser.id
  }, workspaceIds!.alternateWorktreeId)
  const mainBrowser = orcaPage.locator(`[data-browser-overlay-tab-id="${mainBrowserTabId}"]`)
  await expect(mainBrowser).toBeVisible()

  const auxTabCountBeforeNormalClose = await firstAux
    .locator('[data-testid="sortable-tab"]')
    .count()
  await expect
    .poll(() =>
      orcaPage.evaluate((ptyId) => window.api.pty.inspectProcess(ptyId), firstAuxTerminal!.ptyId)
    )
    .toMatchObject({ hasChildProcesses: false })
  await firstAux
    .locator(`[data-terminal-overlay-tab-id="${switchedTabId}"] .xterm-helper-textarea`)
    .focus()
  await firstAux.keyboard.press(process.platform === 'darwin' ? 'Meta+W' : 'Control+W')
  await expect(firstAux.locator('[data-testid="sortable-tab"]')).toHaveCount(
    auxTabCountBeforeNormalClose - 1
  )
  await expect(mainBrowser).toBeVisible()

  await orcaPage.evaluate((worktreeId) => {
    const state = window.__store.getState()
    state.setActiveWorktree(worktreeId)
    state.setActiveView('terminal')
  }, workspaceIds!.originalWorktreeId)

  await firstAux.close()
  await expect(orcaPage.locator('.xterm-screen:visible')).toHaveCount(1, { timeout: 30_000 })
  await expect(secondAux.locator('.xterm-screen')).toBeVisible()

  await secondAux.close()
  await expect(orcaPage.locator('.xterm-screen:visible')).toHaveCount(2, { timeout: 30_000 })
})
