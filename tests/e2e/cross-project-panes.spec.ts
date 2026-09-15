import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { worktreeRowSurface } from './worktree-row-locators'
import { startPlacementFixtureServer } from './helpers/paired-browser-placement-fixture'

test('cross-project panes retain terminals and actual unsaved editor buffers through layout changes', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  const errors: string[] = []
  orcaPage.on('pageerror', (error) => errors.push(error.message))
  const folder = testInfo.outputPath('pane-folder')
  mkdirSync(folder, { recursive: true })
  const filePath = path.join(folder, 'draft.md')
  writeFileSync(filePath, '# Pane draft\n\nOriginal text\n')
  const fixture = await orcaPage.evaluate(
    async ({ folder, filePath }) => {
      const state = window.__store!.getState()
      const original = state.activeWorktreeId!
      const terminal = state.tabsByWorktree[original]?.[0] ?? state.createTab(original)
      const second = state.createTab(original)
      state.setTabCustomTitle(terminal.id, 'Pane first shell')
      state.setTabCustomTitle(second.id, 'Pane second shell')
      const repo = await state.addNonGitFolder(folder)
      if (!repo) {
        throw new Error('Folder project was not added')
      }
      const folderId = window.__store!.getState().worktreesByRepo[repo.id]![0]!.id
      state.openFile({
        worktreeId: folderId,
        filePath,
        relativePath: 'draft.md',
        language: 'markdown',
        mode: 'edit'
      })
      return { original, folderId, first: terminal.id, second: second.id }
    },
    { folder, filePath }
  )
  await worktreeRowSurface(orcaPage, fixture.original).click()
  await orcaPage.locator(`[data-tab-id="${fixture.first}"]`).click()
  await orcaPage.getByRole('button', { name: 'Split Right', exact: true }).click()
  const panes = orcaPage.getByRole('region', { name: 'Workspace pane', exact: true })
  await expect(panes).toHaveCount(2)
  await worktreeRowSurface(orcaPage, fixture.folderId).click()
  await panes.nth(1).locator('[data-tab-id]').filter({ hasText: 'draft.md' }).click()
  const editor = orcaPage.locator('.rich-markdown-editor:visible')
  await expect(editor).toBeVisible()
  const editorHandle = await editor.elementHandle()
  await editor.click()
  await orcaPage.keyboard.press('ControlOrMeta+End')
  await orcaPage.keyboard.press('Enter')
  await orcaPage.keyboard.type('UNSAVED PANE SENTINEL')
  await expect(editor).toContainText('UNSAVED PANE SENTINEL')
  expect(readFileSync(filePath, 'utf8')).not.toContain('UNSAVED PANE SENTINEL')
  const terminal = orcaPage.locator(`[data-terminal-overlay-tab-id="${fixture.second}"]`)
  await expect(terminal).toBeVisible()
  const terminalHandle = await terminal.elementHandle()
  await panes.nth(1).getByRole('button', { name: 'Window actions', exact: true }).click()
  await orcaPage.getByRole('menuitem', { name: 'Split Down', exact: true }).click()
  await expect(panes).toHaveCount(3)
  await panes.nth(2).getByRole('button', { name: 'Expand Pane', exact: true }).click()
  await expect(editor).toContainText('UNSAVED PANE SENTINEL')
  await orcaPage.getByRole('button', { name: 'Restore Layout', exact: true }).click()
  await expect(editor).toContainText('UNSAVED PANE SENTINEL')
  await expect(terminal).toBeVisible()
  expect(await terminalHandle!.evaluate((element) => element.isConnected)).toBe(true)
  expect(await editorHandle!.evaluate((element) => element.isConnected)).toBe(true)
  await orcaPage.screenshot({ path: testInfo.outputPath('cross-project-panes.png') })
  expect(errors).toEqual([])
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})

test('cross-project panes retain the same live browser guest through split and expansion', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  const server = await startPlacementFixtureServer()
  try {
    const folder = testInfo.outputPath('browser-folder')
    mkdirSync(folder, { recursive: true })
    const fixture = await orcaPage.evaluate(
      async ({ folder, url }) => {
        const state = window.__store!.getState()
        const original = state.activeWorktreeId!
        const terminal = state.tabsByWorktree[original]?.[0] ?? state.createTab(original)
        const repo = await state.addNonGitFolder(folder)
        if (!repo) {
          throw new Error('Folder project was not added')
        }
        const folderId = window.__store!.getState().worktreesByRepo[repo.id]![0]!.id
        const browser = state.createBrowserTab(folderId, url, { activate: true })
        return { original, folderId, terminalId: terminal.id, browserId: browser.id }
      },
      { folder, url: server.url }
    )
    await worktreeRowSurface(orcaPage, fixture.folderId).click()
    await orcaPage.locator(`[data-tab-id="${fixture.browserId}"]`).click()
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ webContents }, url) =>
            webContents.getAllWebContents().find((contents) => contents.getURL() === url)?.id ??
            null,
          server.url
        )
      )
      .toBeTruthy()
    const guestId = await electronApp.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === url)!
      await guest.executeJavaScript(
        `document.body.innerHTML = '<input id="pane-draft" value="live pane draft">'`
      )
      return guest.id
    }, server.url)
    await orcaPage.getByRole('button', { name: 'Split Right', exact: true }).click()
    const panes = orcaPage.getByRole('region', { name: 'Workspace pane', exact: true })
    await panes.nth(0).locator('[data-tab-id]').first().click()
    await worktreeRowSurface(orcaPage, fixture.original).click()
    await panes.nth(0).locator(`[data-tab-id="${fixture.terminalId}"]`).click()
    await expect(
      orcaPage.locator(`[data-terminal-overlay-tab-id="${fixture.terminalId}"]`)
    ).toBeVisible()
    const guest = orcaPage.locator('webview')
    await expect(guest).toBeVisible()
    const guestHandle = await guest.elementHandle()
    await panes.nth(1).getByRole('button', { name: 'Expand Pane', exact: true }).click()
    await orcaPage.getByRole('button', { name: 'Restore Layout', exact: true }).click()
    await expect(guest).toBeVisible()
    expect(await guestHandle!.evaluate((element) => element.isConnected)).toBe(true)
    expect(
      await electronApp.evaluate(
        async ({ webContents }, id) =>
          webContents.fromId(id)!.executeJavaScript('document.querySelector("#pane-draft").value'),
        guestId
      )
    ).toBe('live pane draft')
    await orcaPage.screenshot({ path: testInfo.outputPath('cross-project-browser.png') })
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
  } finally {
    await server.close()
  }
})
