import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAYUlEQVR4nO3PIREAIBAAMFqhMWgyUYMun4QQaBQZEO92twIrZ/RUde1URUBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEDgO9BiprrRUgkICAgICAgICAgICAgICAgICAgICAgIfHuebLmH1pKnMwAAAABJRU5ErkJggg=='

test('image previews copy, save and route local file actions without closing the popup', async ({
  orcaPage,
  electronApp,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const filename = 'image-actions-proof.png'
  const filePath = path.join(seededRepoPath, filename)
  writeFileSync(filePath, Buffer.from(PNG, 'base64'))
  registerPostElectronShutdownCleanup(async () => rmSync(filePath, { force: true }))
  // Capture only this isolated app's IPC; never touch the user's clipboard or launch OS apps.
  await electronApp.evaluate(({ ipcMain }) => {
    for (const channel of [
      'clipboard:writeImage',
      'clipboard:writeText',
      'fs:saveDownloadedFile',
      'shell:openPath',
      'shell:openInFileManager'
    ]) {
      ipcMain.removeHandler(channel)
    }
    ipcMain.handle('clipboard:writeImage', (_event, image: string) => {
      process.env.ORCA_E2E_IMAGE_ACTION_IMAGE = image
    })
    ipcMain.handle('clipboard:writeText', (_event, text: string) => {
      process.env.ORCA_E2E_IMAGE_ACTION_TEXT = text
    })
    ipcMain.handle('fs:saveDownloadedFile', (_event, args) => {
      process.env.ORCA_E2E_IMAGE_ACTION_SAVE = JSON.stringify(args)
      return { canceled: true }
    })
    ipcMain.handle('shell:openPath', (_event, path: string, owner: string) => {
      process.env.ORCA_E2E_IMAGE_ACTION_OPEN = JSON.stringify({ path, owner })
    })
    ipcMain.handle('shell:openInFileManager', (_event, path: string, owner: string) => {
      process.env.ORCA_E2E_IMAGE_ACTION_REVEAL = JSON.stringify({ path, owner })
      return { ok: true }
    })
  })
  const captured = (name: string): Promise<string | null> =>
    electronApp.evaluate((_electron, name) => process.env[name] ?? null, name)

  await orcaPage.evaluate(
    ({ filePath, filename }) => {
      const state = window.__store?.getState()
      if (!state?.activeWorktreeId) {
        throw new Error('No fixture worktree')
      }
      state.openFile({
        filePath,
        relativePath: filename,
        worktreeId: state.activeWorktreeId,
        language: 'plaintext',
        mode: 'edit'
      })
    },
    { filePath, filename }
  )
  const image = orcaPage.getByRole('img', { name: filename, exact: true })
  await expect(image).toBeVisible()
  await image.click({ button: 'right' })
  const menu = orcaPage.locator('[data-image-actions-menu][data-state="open"]')
  await expect(menu.getByRole('menuitem')).toHaveCount(5)
  await menu.getByRole('menuitem', { name: 'Copy image', exact: true }).click()
  await expect
    .poll(() => captured('ORCA_E2E_IMAGE_ACTION_IMAGE'))
    .toBe(`data:image/png;base64,${PNG}`)

  const openMenu = async (): Promise<void> => {
    await orcaPage.getByRole('button', { name: 'Image actions', exact: true }).click()
    await expect(menu.getByRole('menuitem')).toHaveCount(5)
  }
  await openMenu()
  await menu.getByRole('menuitem', { name: 'Save image as…', exact: true }).click()
  await expect
    .poll(() => captured('ORCA_E2E_IMAGE_ACTION_SAVE'))
    .toBe(
      JSON.stringify({
        suggestedName: filename,
        content: PNG,
        encoding: 'base64'
      })
    )
  await expect(orcaPage.getByText('Image saved', { exact: true })).toHaveCount(0)
  await openMenu()
  await menu.getByRole('menuitem', { name: 'Copy image path', exact: true }).click()
  await expect.poll(() => captured('ORCA_E2E_IMAGE_ACTION_TEXT')).toBe(filePath)
  await openMenu()
  await menu.getByRole('menuitem').nth(3).click()
  await expect
    .poll(() => captured('ORCA_E2E_IMAGE_ACTION_REVEAL'))
    .toBe(JSON.stringify({ path: filePath, owner: 'local' }))
  await openMenu()
  await menu.getByRole('menuitem', { name: 'Open with default app', exact: true }).click()
  await expect
    .poll(() => captured('ORCA_E2E_IMAGE_ACTION_OPEN'))
    .toBe(JSON.stringify({ path: filePath, owner: 'local' }))

  await orcaPage.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await image.click()
  const popup = orcaPage.getByRole('dialog', { name: filename, exact: true })
  await expect(popup).toBeVisible()
  await expect(popup.getByText('125%', { exact: true })).toBeVisible()
  await popup.getByRole('img', { name: filename, exact: true }).click({ button: 'right' })
  await expect(menu.getByRole('menuitem')).toHaveCount(5)
  await orcaPage.screenshot({
    path: testInfo.outputPath('image-popup-context-menu.png'),
    animations: 'disabled'
  })
  await menu.getByRole('menuitem', { name: 'Copy image path', exact: true }).click()
  await expect(popup).toBeVisible()
  await electronApp.evaluate(() => {
    delete process.env.ORCA_E2E_IMAGE_ACTION_IMAGE
  })
  await popup.getByRole('button', { name: 'Image actions', exact: true }).click()
  await menu.getByRole('menuitem', { name: 'Copy image', exact: true }).click()
  await expect
    .poll(() => captured('ORCA_E2E_IMAGE_ACTION_IMAGE'))
    .toBe(`data:image/png;base64,${PNG}`)
  await expect(popup).toBeVisible()
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)
})
