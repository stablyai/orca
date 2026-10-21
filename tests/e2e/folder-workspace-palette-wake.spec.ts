import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  expectTerminalAccessibilityText,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

test.use({ seedTestRepo: false })

for (const selection of ['workspace', 'tab'] as const) {
  test(`Cmd+J ${selection} selection wakes a sleeping folder and restores Files mode`, async ({
    orcaPage,
    electronApp,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const folderPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-folder-wake-')))
    registerPostElectronShutdownCleanup(async () =>
      rmSync(folderPath, { recursive: true, force: true })
    )
    await waitForSessionReady(orcaPage)
    const folders = await orcaPage.evaluate(async (folderPath) => {
      const store = window.__store!
      await store.getState().updateSettingsOrThrow({ defaultTuiAgent: 'blank' })
      const group = await window.api.projectGroups.create({
        name: 'Folder wake regression',
        parentPath: folderPath,
        createdFrom: 'folder-scan'
      })
      await store.getState().fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
      const target = await store
        .getState()
        .createFolderWorkspace(
          { projectGroupId: group.id, name: 'Sleeping research', folderPath },
          { runtimeEnvironmentId: null }
        )
      const other = await store
        .getState()
        .createFolderWorkspace(
          { projectGroupId: group.id, name: 'Other research', folderPath },
          { runtimeEnvironmentId: null }
        )
      if (!target || !other) {
        throw new Error('Could not create folder workspaces')
      }
      return { target: target.id, other: other.id }
    }, folderPath)
    const openPalette = async (): Promise<void> => {
      // Native menu accelerators need desktop focus; drive the same palette through CDP.
      await orcaPage.evaluate(() => window.__store!.getState().openModal('worktree-palette'))
    }
    const palette = orcaPage.getByRole('dialog', { name: 'Jump to...' })
    await openPalette()
    await palette.getByRole('combobox').fill('Sleeping research')
    await palette.getByRole('combobox').press('Enter')
    await expect(palette).toHaveCount(0)
    await waitForActiveTerminalManager(orcaPage)
    await waitForActivePanePtyId(orcaPage)
    const tabId = await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      const tabId = state.activeTabId
      if (!tabId) {
        throw new Error('Folder terminal is missing')
      }
      state.setTabCustomTitle(tabId, 'Wake marker terminal')
      state.showRightSidebarFiles()
      return tabId
    })
    await expect(orcaPage.getByRole('textbox', { name: 'Find files', exact: true })).toBeVisible()
    await openPalette()
    await palette.getByRole('combobox').fill('Other research')
    await palette.getByRole('combobox').press('Enter')
    await expect(palette).toHaveCount(0)
    await orcaPage.evaluate(async (targetId) => {
      const state = window.__store!.getState()
      state.showRightSidebarSearch()
      await state.shutdownWorktreeTerminals(`folder:${targetId}`, { keepIdentifiers: true })
    }, folders.target)
    await expect(orcaPage.getByRole('textbox', { name: 'Find files', exact: true })).toBeHidden()

    await openPalette()
    const query = selection === 'workspace' ? 'Sleeping research' : 'Wake marker terminal'
    await palette.getByRole('combobox').fill(query)
    const row = palette.locator('[cmdk-item][data-selected="true"]')
    await expect(row).toContainText(query)
    await palette.getByRole('combobox').press('Enter')
    await expect(palette).toHaveCount(0)
    await expect(orcaPage.getByRole('textbox', { name: 'Find files', exact: true })).toBeVisible()
    await waitForActiveTerminalManager(orcaPage)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await execInTerminal(orcaPage, ptyId, 'echo FOLDER_WAKE_OK')
    await expectTerminalAccessibilityText(orcaPage, tabId, 'FOLDER_WAKE_OK')
    await orcaPage.screenshot({ path: testInfo.outputPath(`folder-${selection}-wake.png`) })
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
  })
}
