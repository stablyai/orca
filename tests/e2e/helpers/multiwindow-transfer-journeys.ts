import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './orca-app'
import { openWorkspaceWindow, expectHiddenWorkspaceWindows } from './workspace-window'
import { worktreeRowSurface } from '../worktree-row-locators'
import { startPlacementFixtureServer } from './paired-browser-placement-fixture'

async function transfer(page: Page, destinationId: number, action: string): Promise<void> {
  await page
    .locator('[data-current="true"]')
    .getByRole('button', { name: 'Window actions' })
    .click()
  await page.getByRole('menuitem', { name: action, exact: true }).hover()
  await page
    .getByRole('menuitem')
    .filter({ hasText: `(${destinationId})` })
    .click()
}

export function registerMultiwindowTransferJourneys() {
  test('duplicate and move terminal views retain the same live shell and hand off control', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    const terminal = await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      const worktreeId = state.activeWorktreeId!
      const tab = state.tabsByWorktree[worktreeId]?.[0] ?? state.createTab(worktreeId)
      state.setTabCustomTitle(tab.id, 'Transfer shell')
      return { id: tab.id, worktreeId }
    })
    await expect
      .poll(() =>
        orcaPage.evaluate(
          ({ id, worktreeId }) =>
            window.__store!.getState().tabsByWorktree[worktreeId]?.find((tab) => tab.id === id)
              ?.ptyId,
          terminal
        )
      )
      .toBeTruthy()
    const ptyId = await orcaPage.evaluate(
      ({ id, worktreeId }) =>
        window.__store!.getState().tabsByWorktree[worktreeId]!.find((tab) => tab.id === id)!.ptyId,
      terminal
    )
    await orcaPage.getByRole('button', { name: 'Window actions', exact: true }).click()
    await orcaPage.getByRole('menuitem', { name: 'Open Another View', exact: true }).click()
    await expect(orcaPage.getByText('Watching', { exact: true })).toHaveCount(1)
    await expect(orcaPage.locator('[data-watching-terminal-view] .xterm')).toHaveCount(1)
    await orcaPage.getByRole('button', { name: 'Take Control Here' }).click()
    const secondary = await openWorkspaceWindow(electronApp)
    const destinationId = await secondary.evaluate(() => window.orcaWorkspaceViews!.ready())
    await worktreeRowSurface(secondary, terminal.worktreeId).click()
    await expect(orcaPage.getByText('Watching', { exact: true })).toHaveCount(1)
    await expect(secondary.getByText('Watching', { exact: true })).toHaveCount(1)
    await secondary.getByRole('button', { name: 'Take Control Here' }).click()
    await expect(orcaPage.getByText('Watching', { exact: true })).toHaveCount(2)
    await orcaPage.getByRole('button', { name: 'Take Control Here' }).first().click()
    await expect(orcaPage.getByText('Watching', { exact: true })).toHaveCount(1)
    await expect(secondary.getByText('Watching', { exact: true })).toHaveCount(1)
    await expectHiddenWorkspaceWindows(electronApp)
    await orcaPage.screenshot({ path: testInfo.outputPath('terminal-repeated-panes.png') })
    const before = await orcaPage.evaluate(
      () => Object.keys(window.__store!.getState().windowPaneLayout!.views).length
    )
    await transfer(orcaPage, destinationId, 'Move to Window')
    await expect
      .poll(() =>
        orcaPage.evaluate(
          () => Object.keys(window.__store!.getState().windowPaneLayout!.views).length
        )
      )
      .toBe(before - 1)
    await expect(secondary.getByText('Watching', { exact: true })).toHaveCount(1)
    await secondary.getByRole('button', { name: 'Take Control Here' }).click()
    await expect(secondary.getByText('Watching', { exact: true })).toHaveCount(0)
    await expectHiddenWorkspaceWindows(electronApp)
    await expect(secondary.locator('[data-terminal-overlay-tab-id]:visible .xterm')).toHaveCount(1)
    await secondary.locator('[data-terminal-overlay-tab-id]:visible .xterm-helper-textarea').focus()
    await secondary.keyboard.type('echo PANE_TRANSFER_CONTINUITY')
    await secondary.keyboard.press('Enter')
    await expect
      .poll(() =>
        orcaPage.evaluate(async (id) => {
          const result = await window.api.terminalPreview.connect(id!, { viewId: 'transfer-proof' })
          await window.api.terminalPreview.unsubscribe(id!, 'transfer-proof')
          return `${result.snapshot?.scrollbackAnsi ?? ''}${result.snapshot?.data ?? ''}`.split(
            'PANE_TRANSFER_CONTINUITY'
          ).length
        }, ptyId)
      )
      .toBeGreaterThanOrEqual(3)
    await secondary.screenshot({ path: testInfo.outputPath('terminal-moved.png') })
    const primaryId = await orcaPage.evaluate(() => window.orcaWorkspaceViews!.ready())
    await transfer(secondary, primaryId, 'Combine Windows as Panes')
    await expect
      .poll(() =>
        secondary.evaluate(
          () => Object.keys(window.__store!.getState().windowPaneLayout!.views).length
        )
      )
      .toBe(0)
    await expect(orcaPage.getByRole('region', { name: 'Workspace pane', exact: true })).toHaveCount(
      3
    )
    await expectHiddenWorkspaceWindows(electronApp)
    await transfer(orcaPage, destinationId, 'Combine Windows as Tabs')
    await expect
      .poll(() =>
        orcaPage.evaluate(
          () => Object.keys(window.__store!.getState().windowPaneLayout!.views).length
        )
      )
      .toBe(0)
    await expect(secondary.locator('[data-tab-group-strip-id] [data-tab-id]')).toHaveCount(3)
    await expectHiddenWorkspaceWindows(electronApp)
    await secondary.evaluate(() => window.api.ui.requestClose())
    expect(
      await orcaPage.evaluate(
        ({ id, worktreeId }) =>
          window.__store!.getState().tabsByWorktree[worktreeId]!.find((tab) => tab.id === id)!
            .ptyId,
        terminal
      )
    ).toBe(ptyId)
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
  })

  test('Move to Window preserves an actual unsaved editor draft', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    const folder = testInfo.outputPath('draft-folder')
    mkdirSync(folder, { recursive: true })
    const filePath = path.join(folder, 'draft.md')
    writeFileSync(filePath, '# Transfer draft\n\nOriginal\n')
    const worktreeId = await orcaPage.evaluate(
      async ({ folder, filePath }) => {
        const state = window.__store!.getState()
        const repo = await state.addNonGitFolder(folder)
        const worktreeId = window.__store!.getState().worktreesByRepo[repo!.id]![0]!.id
        state.openFile({
          worktreeId,
          filePath,
          relativePath: 'draft.md',
          language: 'markdown',
          mode: 'edit'
        })
        return worktreeId
      },
      { folder, filePath }
    )
    await worktreeRowSurface(orcaPage, worktreeId).click()
    await orcaPage.locator('[data-tab-id]').filter({ hasText: 'draft.md' }).click()
    const editor = orcaPage.locator('.rich-markdown-editor')
    await editor.click()
    await orcaPage.keyboard.press('ControlOrMeta+End')
    await orcaPage.keyboard.press('Enter')
    await orcaPage.keyboard.type('UNSAVED TRANSFER SENTINEL')
    await expect(editor).toContainText('UNSAVED TRANSFER SENTINEL')
    const secondary = await openWorkspaceWindow(electronApp)
    await worktreeRowSurface(secondary, worktreeId).click()
    await expect(secondary.locator('.rich-markdown-editor:visible')).toContainText('Original')
    const destinationId = await secondary.evaluate(() => window.orcaWorkspaceViews!.ready())
    await transfer(orcaPage, destinationId, 'Move to Window')
    await expect(secondary.locator('.rich-markdown-editor:visible')).toContainText(
      'UNSAVED TRANSFER SENTINEL'
    )
    await expect(orcaPage.locator('.rich-markdown-editor:visible')).toHaveCount(0)
    expect(readFileSync(filePath, 'utf8')).not.toContain('UNSAVED TRANSFER SENTINEL')
    await secondary.screenshot({ path: testInfo.outputPath('draft-moved.png') })
    await expectHiddenWorkspaceWindows(electronApp)
  })

  test('browser duplicate and move retain guest state and frames after source detaches', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    const server = await startPlacementFixtureServer()
    try {
      const browser = await orcaPage.evaluate((url) => {
        const state = window.__store!.getState()
        return state.createBrowserTab(state.activeWorktreeId!, url, { activate: true })
      }, server.url)
      await expect
        .poll(() =>
          electronApp.evaluate(
            ({ webContents }, url) =>
              webContents.getAllWebContents().find((guest) => guest.getURL() === url)?.id,
            server.url
          )
        )
        .toBeTruthy()
      const guestId = await electronApp.evaluate(async ({ webContents }, url) => {
        const guest = webContents.getAllWebContents().find((guest) => guest.getURL() === url)!
        await guest.executeJavaScript(
          `document.body.innerHTML = '<input id="continuity" value="browser draft">'`
        )
        return guest.id
      }, server.url)
      const secondary = await openWorkspaceWindow(electronApp)
      await worktreeRowSurface(secondary, browser.worktreeId).click()
      const destinationId = await secondary.evaluate(() => window.orcaWorkspaceViews!.ready())
      await transfer(orcaPage, destinationId, 'Open Another View in Window')
      await expect(secondary.getByAltText('Shared browser view')).toBeVisible()
      await transfer(orcaPage, destinationId, 'Move to Window')
      await expect(orcaPage.locator(`[data-tab-id="${browser.id}"]`)).toHaveCount(0)
      await expect(secondary.getByAltText('Shared browser view')).toBeVisible()
      await secondary.getByRole('button', { name: 'Take Control Here' }).click()
      await expect(secondary.getByText('Watching', { exact: true })).toHaveCount(0)
      expect(
        await electronApp.evaluate(
          async ({ webContents }, id) =>
            webContents
              .fromId(id)!
              .executeJavaScript('document.querySelector("#continuity").value'),
          guestId
        )
      ).toBe('browser draft')
      const primaryId = await orcaPage.evaluate(() => window.orcaWorkspaceViews!.ready())
      await orcaPage.evaluate(() => window.api.ui.requestClose())
      await expect
        .poll(() =>
          secondary.evaluate(
            async (id) =>
              (await window.orcaWorkspaceViews!.list()).some((entry) => entry.id === id),
            primaryId
          )
        )
        .toBe(false)
      expect(
        await electronApp.evaluate(
          async ({ webContents }, id) =>
            webContents
              .fromId(id)!
              .executeJavaScript('document.querySelector("#continuity").value'),
          guestId
        )
      ).toBe('browser draft')
      await secondary.screenshot({ path: testInfo.outputPath('browser-moved.png') })
      await expectHiddenWorkspaceWindows(electronApp)
    } finally {
      await server.close()
    }
  })
}
