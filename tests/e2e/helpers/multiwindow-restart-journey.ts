import type { Page, TestInfo } from '@stablyai/playwright-test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './paired-electron-client'
import { closeElectronAppForE2E } from './electron-process-shutdown'
import { openWorkspaceWindow, expectHiddenWorkspaceWindows } from './workspace-window'
import { worktreeRowSurface } from '../worktree-row-locators'
import { buildOwnedEditorFileId } from '../../../src/renderer/src/store/slices/editor/file-ids/editor-file-ids'
import { getTerminalContent, waitForActivePanePtyId } from './terminal'

export async function multiwindowRestartJourney(
  { orcaPage }: { orcaPage: Page },
  testInfo: TestInfo
) {
  test.setTimeout(240_000)
  const folder = testInfo.outputPath('restart-folder')
  mkdirSync(folder, { recursive: true })
  const filePath = path.join(folder, 'restart-draft.md')
  writeFileSync(filePath, '# Restart draft\n\nOriginal\n')
  const fixture = await orcaPage.evaluate(
    async ({ folder, filePath }) => {
      const state = window.__store!.getState()
      const worktreeId = state.activeWorktreeId!
      const tab = state.createTab(worktreeId)
      state.setTabCustomTitle(tab.id, 'PANE4 restart selected')
      const repo = await state.addNonGitFolder(folder)
      const folderId = window.__store!.getState().worktreesByRepo[repo!.id]![0]!.id
      state.openFile({
        worktreeId: folderId,
        filePath,
        relativePath: 'restart-draft.md',
        language: 'markdown',
        mode: 'edit'
      })
      return { worktreeId, folderId, terminalId: tab.id }
    },
    { folder, filePath }
  )
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  let client: PairedElectronClient | null = await launchPairedElectronClient(
    offer,
    testInfo,
    'Window restore'
  )
  try {
    const errors: string[] = []
    const observe = (page: Page) => {
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error') {
          errors.push(message.text())
        }
      })
    }
    observe(client.page)
    await worktreeRowSurface(client.page, fixture.worktreeId).click()
    await client.page.locator('[data-tab-id]').filter({ hasText: 'PANE4 restart selected' }).click()
    await waitForActivePanePtyId(client.page)
    await client.page.getByRole('button', { name: 'Dismiss setup scripts' }).click()
    await expect.poll(() => getTerminalContent(client!.page)).not.toBe('')
    await client.page
      .locator('[data-terminal-overlay-tab-id]:visible .xterm-helper-textarea')
      .focus()
    await client.page.keyboard.type('echo WINDOW_QA_BEFORE_RESTART', { delay: 30 })
    await client.page.keyboard.press('Enter')
    await expect
      .poll(
        async () =>
          (await getTerminalContent(client!.page)).split('WINDOW_QA_BEFORE_RESTART').length
      )
      .toBeGreaterThanOrEqual(3)
    const originalPtyId = await orcaPage.evaluate(
      ({ worktreeId, terminalId }) =>
        window.__store!.getState().tabsByWorktree[worktreeId]!.find((tab) => tab.id === terminalId)!
          .ptyId,
      fixture
    )
    expect(originalPtyId).toBeTruthy()
    let secondary = await openWorkspaceWindow(client.app)
    observe(secondary)
    await worktreeRowSurface(secondary, fixture.worktreeId).click()
    await secondary.locator('[data-tab-id]').filter({ hasText: 'PANE4 restart selected' }).click()
    const dismissSetup = secondary.getByRole('button', { name: 'Dismiss setup scripts' })
    if (await dismissSetup.isVisible()) {
      await dismissSetup.click()
    }
    await worktreeRowSurface(secondary, fixture.folderId).click()
    await secondary.locator('[data-tab-id]').filter({ hasText: 'restart-draft.md' }).click()
    const editor = secondary.locator('.rich-markdown-editor:visible')
    await editor.click()
    await secondary.keyboard.press('ControlOrMeta+End')
    await secondary.keyboard.press('Enter')
    await secondary.keyboard.type('WINDOW QA UNSAVED RESTART')
    await expect(editor).toContainText('WINDOW QA UNSAVED RESTART')
    await secondary.getByRole('button', { name: 'Split Right', exact: true }).click()
    await secondary
      .locator('[data-pane-id][data-current="true"]')
      .getByRole('button', { name: 'Expand Pane', exact: true })
      .click()
    await secondary.getByRole('button', { name: 'Restore Layout', exact: true }).click()
    const secondaryId = await secondary.evaluate(() => window.orcaWorkspaceViews!.ready())
    await secondary.evaluate(() => window.__store!.getState().openModal('worktree-palette'))
    await secondary.getByRole('combobox').fill('PANE4 restart selected')
    await secondary
      .locator(`[data-value^="workspace-view:${secondaryId}:"]`)
      .filter({ hasText: 'PANE4 restart selected' })
      .click()
    await expect(
      secondary
        .locator('[data-tab-id][data-active="true"]')
        .filter({ hasText: 'PANE4 restart selected' })
    ).toHaveCount(1)
    await secondary.locator('.rich-markdown-editor:visible').click()
    const savedLayout = await secondary.evaluate(async () => {
      const state = window.__store!.getState()
      state.setWindowPaneRatio('', 0.35)
      const layout = window.__store!.getState().windowPaneLayout!
      await window.api.ui.set({ windowPaneLayout: layout })
      return layout
    })
    expect(savedLayout.root.type).toBe('split')
    expect(savedLayout.expandedPaneId).toBeNull()
    const hydratedLayout = {
      ...savedLayout,
      views: Object.fromEntries(
        Object.entries(savedLayout.views).map(([id, view]) => [
          id,
          view.contentType === 'editor'
            ? {
                ...view,
                entityId: buildOwnedEditorFileId(
                  filePath,
                  view.worktreeId,
                  view.executionHostId.slice('runtime:'.length)
                )
              }
            : view
        ])
      )
    }
    const windowId = await client.page.evaluate(
      async () => (await window.api.ui.get()).workspaceWindowIds?.[0]
    )
    expect(windowId).toBeTruthy()
    const nativeId = await secondary.evaluate(() => window.orcaWorkspaceWindowNative!.getWindowId())
    const bounds = await client.app.evaluate(({ BrowserWindow, screen }, id) => {
      const window = BrowserWindow.fromId(id)!
      const area = screen.getPrimaryDisplay().workArea
      const bounds = {
        x: area.x + 30,
        y: area.y + 30,
        width: Math.min(1400, area.width - 60),
        height: Math.min(900, area.height - 60)
      }
      window.setBounds(bounds)
      return window.getBounds()
    }, nativeId)
    await expect
      .poll(() =>
        client!.page.evaluate(
          async (id) => (await window.api.ui.get()).workspaceWindowPlacements?.[id!]?.bounds,
          windowId
        )
      )
      .toEqual(bounds)
    expect(await secondary.evaluate(() => window.__store!.getState().windowPaneLayout)).toEqual(
      savedLayout
    )
    await secondary.evaluate(() => window.api.ui.requestClose())
    await expect.poll(() => secondary.isClosed()).toBe(true)
    secondary = await openWorkspaceWindow(client.app, 'Reopen Closed View')
    observe(secondary)
    await secondary.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
    await expect
      .poll(() => secondary.evaluate(() => window.__store!.getState().windowPaneLayout))
      .toEqual(hydratedLayout)
    await testInfo.attach('reopened-selection', {
      body: JSON.stringify(
        await secondary.evaluate(() => ({
          layout: window.__store!.getState().windowPaneLayout,
          tabs: window.__store!.getState().unifiedTabsByWorktree,
          visible: [...document.querySelectorAll('[data-tab-id]')].map((el) =>
            el.outerHTML.slice(0, 650)
          )
        })),
        null,
        2
      ),
      contentType: 'application/json'
    })
    await expect(secondary.locator('.rich-markdown-editor:visible')).toContainText(
      'WINDOW QA UNSAVED RESTART'
    )
    await expectHiddenWorkspaceWindows(client.app)
    const profile = client.userDataDir
    const origin = await secondary.evaluate(() => location.origin)
    await closeElectronAppForE2E(client.app)
    client = null
    client = await launchPairedElectronClient(offer, testInfo, 'Window restore', {
      reuseUserDataDir: profile
    })
    observe(client.page)
    await expect
      .poll(
        () =>
          client!.app.evaluate(({ BrowserWindow }, id) => {
            const window = BrowserWindow.getAllWindows().find((window) =>
              window.webContents.session.storagePath?.includes(`orca-workspace-window-${id}`)
            )
            return window ? { bounds: window.getBounds(), visible: window.isVisible() } : null
          }, windowId),
        { timeout: 30_000 }
      )
      .toEqual({ bounds, visible: false })
    const restored = client.app
      .windows()
      .find((page) => page.url().startsWith('http://127.0.0.1:'))!
    await restored.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
    observe(restored)
    expect(await restored.evaluate(() => location.origin)).not.toBe(origin)
    await testInfo.attach('restart-storage', {
      body: JSON.stringify({
        origin,
        restored: await restored.evaluate(async () => ({
          origin: location.origin,
          localLayout: (await window.api.ui.get()).windowPaneLayout,
          storageKeys: Object.keys(localStorage),
          ready: window.__store!.getState().persistedUIReady,
          hydrated: window.__store!.getState().hydrationSucceeded
        }))
      }),
      contentType: 'application/json'
    })
    await expect
      .poll(() => restored.evaluate(() => window.__store!.getState().windowPaneLayout))
      .toEqual(hydratedLayout)
    await expect(restored.getByRole('region', { name: 'Workspace pane', exact: true })).toHaveCount(
      2
    )
    await expect(
      restored
        .locator('[data-tab-id][data-active="true"]')
        .filter({ hasText: 'PANE4 restart selected' })
    ).toBeVisible()
    await expect(
      restored.locator('[data-tab-id][data-active="true"]').filter({ hasText: 'restart-draft.md' })
    ).toBeVisible()
    await expect(restored.locator('.rich-markdown-editor:visible')).toContainText(
      'WINDOW QA UNSAVED RESTART'
    )
    await expect(client.page.locator('[data-tab-id][data-active="true"]')).toContainText(
      'PANE4 restart selected'
    )
    await expect(
      restored.locator('[data-pane-context]').filter({ hasText: 'restart-folder' })
    ).toBeVisible()
    expect(readFileSync(filePath, 'utf8')).not.toContain('WINDOW QA UNSAVED RESTART')
    await expect
      .poll(() => getTerminalContent(client!.page), { timeout: 30_000 })
      .toContain('WINDOW_QA_BEFORE_RESTART')
    await client.page
      .locator('[data-terminal-overlay-tab-id]:visible .xterm-helper-textarea')
      .focus()
    await client.page.keyboard.type('echo WINDOW_QA_AFTER_RESTART', { delay: 30 })
    await client.page.keyboard.press('Enter')
    await expect
      .poll(
        async () => (await getTerminalContent(client!.page)).split('WINDOW_QA_AFTER_RESTART').length
      )
      .toBeGreaterThanOrEqual(3)
    expect(
      await orcaPage.evaluate(
        ({ worktreeId, terminalId }) =>
          window
            .__store!.getState()
            .tabsByWorktree[worktreeId]!.find((tab) => tab.id === terminalId)!.ptyId,
        fixture
      )
    ).toBe(originalPtyId)
    await expectHiddenWorkspaceWindows(client.app)
    expect(errors).toEqual([])
    await restored.screenshot({ path: testInfo.outputPath('restored-secondary-window.png') })
  } finally {
    await client?.dispose()
  }
}
