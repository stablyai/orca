import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encodePaletteIdentity } from '../../../../src/shared/palette-match/palette-ranking'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import { waitForSessionReady } from '../../desktop/renderer-probes/store'

test.use({ seedTestRepo: false })

test('finds and opens a folder workspace without repositories', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const folderPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-palette-folder-')))
  registerPostElectronShutdownCleanup(async () =>
    rmSync(folderPath, { recursive: true, force: true })
  )
  await waitForSessionReady(orcaPage)
  const workspaceId = await orcaPage.evaluate(async (folderPath) => {
    const store = window.__store!
    await store.getState().updateSettingsOrThrow({ theme: 'light', defaultTuiAgent: 'blank' })
    const group = await window.api.projectGroups.create({
      name: 'Product research',
      parentPath: folderPath,
      createdFrom: 'folder-scan'
    })
    await store.getState().fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
    const folder = await store
      .getState()
      .createFolderWorkspace(
        { projectGroupId: group.id, name: 'Customer interviews', folderPath },
        { runtimeEnvironmentId: null }
      )
    if (!folder) {
      throw new Error('Could not create folder workspace')
    }
    await store
      .getState()
      .updateFolderWorkspace(folder.folderWorkspace.id, { comment: 'Research synthesis' })
    store.setState({ showSleepingWorkspaces: false })
    return `folder:${folder.folderWorkspace.id}`
  }, folderPath)
  await orcaPage.evaluate(() => window.__store!.getState().openModal('worktree-palette'))
  const palette = orcaPage.getByRole('dialog', { name: 'Jump to...' })
  await expect(palette).toBeVisible()
  const rowId = encodePaletteIdentity(['worktree', `local|${workspaceId}`])
  const row = palette.locator(`[cmdk-item][data-value=${JSON.stringify(rowId)}]`)
  await expect(row).toContainText('Customer interviews')
  const input = palette.locator('[cmdk-input]')
  await input.fill('Research synthesis')
  await expect(row).toContainText('Research synthesis')
  const screenshot = testInfo.outputPath('folder-palette-light.png')
  await palette.screenshot({ path: screenshot, animations: 'disabled' })
  await testInfo.attach('folder-palette-light', { path: screenshot, contentType: 'image/png' })
  await input.press('Enter')
  await expect(palette).toHaveCount(0)
  const sidebarRow = orcaPage.locator(
    `[data-worktree-sidebar] [role="option"][data-worktree-id=${JSON.stringify(workspaceId)}]`
  )
  await expect(sidebarRow).toHaveAttribute('aria-current', 'page')
  await expect(sidebarRow).toContainText('Customer interviews')
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
