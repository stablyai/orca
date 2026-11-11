import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import {
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'

test.use({ seedTestRepo: false })

async function selectInPalette(page: Page, query: string): Promise<void> {
  // Native menu accelerators need desktop focus; open the same palette in the hidden renderer.
  await page.evaluate(() => window.__store!.getState().openModal('worktree-palette'))
  const palette = page.getByRole('dialog', { name: 'Jump to...' })
  await palette.getByRole('combobox').fill(query)
  await expect(palette.locator('[cmdk-item][data-selected="true"]')).toContainText(query)
  await palette.getByRole('combobox').press('Enter')
  await expect(palette).toHaveCount(0)
}

test('Cmd+J terminal tab selection restores keyboard input to the last active split pane', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}) => {
  await orcaPage.setViewportSize({ width: 1200, height: 800 })
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
  const folderPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-cmdj-focus-')))
  registerPostElectronShutdownCleanup(async () =>
    rmSync(folderPath, { recursive: true, force: true })
  )
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async (folderPath) => {
    const store = window.__store!
    await store.getState().updateSettingsOrThrow({ defaultTuiAgent: 'blank' })
    const group = await window.api.projectGroups.create({
      name: 'Palette focus regression',
      parentPath: folderPath,
      createdFrom: 'folder-scan'
    })
    await store.getState().fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
    for (const name of ['Alpha services', 'Beta services']) {
      const workspace = await store
        .getState()
        .createFolderWorkspace(
          { projectGroupId: group.id, name, folderPath },
          { runtimeEnvironmentId: null }
        )
      if (!workspace) {
        throw new Error('Could not create folder workspace')
      }
    }
  }, folderPath)

  await selectInPalette(orcaPage, 'Alpha services')
  await waitForActiveTerminalManager(orcaPage)
  await waitForActivePanePtyId(orcaPage)
  const targetTabId = await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.setTabCustomTitle(state.activeTabId!, 'Example terminal')
    return state.activeTabId!
  })
  await splitActiveTerminalPane(orcaPage, 'vertical')
  await waitForPaneCount(orcaPage, 2)
  await waitForActivePanePtyId(orcaPage)
  await orcaPage.evaluate((tabId) => {
    for (const pane of window.__paneManagers!.get(tabId)!.getPanes()) {
      pane.terminal.options.screenReaderMode = true
    }
  }, targetTabId)
  const targetTab = orcaPage.locator(`[data-terminal-tab-id="${targetTabId}"]`)
  const inputs = targetTab.locator('.xterm-helper-textarea')
  await expect(inputs).toHaveCount(2)
  const expectedInput = inputs.nth(1)
  const outputs = targetTab.locator('.xterm-accessibility-tree')
  const expectedOutput = outputs.nth(1)
  await expectedInput.click()
  await orcaPage.keyboard.type('echo CMDJ_READY')
  await orcaPage.keyboard.press('Enter')
  await expect(expectedOutput).toContainText('CMDJ_READY')

  await selectInPalette(orcaPage, 'Beta services')
  await waitForActiveTerminalManager(orcaPage)
  await waitForActivePanePtyId(orcaPage)
  const otherTabId = await orcaPage.evaluate(() => {
    const tabId = window.__store!.getState().activeTabId!
    window.__paneManagers!.get(tabId)!.getActivePane()!.terminal.options.screenReaderMode = true
    return tabId
  })
  const otherTab = orcaPage.locator(`[data-terminal-tab-id="${otherTabId}"]`)
  await otherTab.locator('.xterm-helper-textarea').click()
  await orcaPage.keyboard.type('echo CMDJ_OTHER_READY')
  await orcaPage.keyboard.press('Enter')
  await expect(otherTab.locator('.xterm-accessibility-tree')).toContainText('CMDJ_OTHER_READY')
  await selectInPalette(orcaPage, 'Example terminal')
  await expect(expectedInput).toBeFocused()
  await orcaPage.keyboard.type('echo CMDJ_RETURNED')
  await orcaPage.keyboard.press('Enter')
  await expect(expectedOutput).toContainText('CMDJ_RETURNED')
  await expect(outputs.first()).not.toContainText('CMDJ_RETURNED')
  await expect(otherTab.locator('.xterm-accessibility-tree')).not.toContainText('CMDJ_RETURNED')
  await expect(expectedInput).toBeFocused()
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
