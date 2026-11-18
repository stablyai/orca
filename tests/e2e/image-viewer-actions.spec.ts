import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATklEQVR42u3PMQ0AAAgDsEnH+ZDAxdekBpomrzL9JSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwWVWG8R4tOdJrAAAAAElFTkSuQmCC'

test('SVG image actions copy HTML labels and expose local file actions', async ({
  orcaPage,
  electronApp,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  await orcaPage.setViewportSize({ width: 1280, height: 800 })
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100" viewBox="0 0 240 100">' +
    '<foreignObject width="240" height="100"><div xmlns="http://www.w3.org/1999/xhtml">' +
    'Mermaid HTML label</div></foreignObject></svg>'
  await electronApp.evaluate(({ ipcMain, nativeImage }) => {
    ipcMain.removeHandler('clipboard:writeImage')
    ipcMain.handle('clipboard:writeImage', (_event, data: string) => {
      process.env.ORCA_E2E_SVG_COPY_SIZE = JSON.stringify(
        nativeImage.createFromDataURL(data).getSize()
      )
    })
  })
  await orcaPage.evaluate((svg) => {
    window.__store!.getState().openModal('diagram-viewer', { svg, background: '#ffffff' })
  }, svg)
  const popup = orcaPage.getByRole('dialog', { name: 'Diagram', exact: true })
  await expect(popup.getByRole('img')).toBeVisible()
  await popup.getByRole('button', { name: 'Image actions', exact: true }).click()
  await orcaPage.getByRole('menuitem', { name: 'Copy image', exact: true }).click()
  await expect
    .poll(() => electronApp.evaluate(() => process.env.ORCA_E2E_SVG_COPY_SIZE))
    .toBe(JSON.stringify({ width: 240, height: 100 }))
  await expect(popup).toBeVisible()
  await popup.getByRole('button', { name: 'Copy as PNG', exact: true }).click()
  await expect
    .poll(() => electronApp.evaluate(() => process.env.ORCA_E2E_SVG_COPY_SIZE))
    .toBe(JSON.stringify({ width: 480, height: 200 }))
  await popup.getByRole('button', { name: 'Close', exact: true }).click()

  const filename = 'image-actions-proof.svg'
  const filePath = path.join(seededRepoPath, filename)
  writeFileSync(filePath, svg)
  registerPostElectronShutdownCleanup(async () => rmSync(filePath, { force: true }))
  await orcaPage.evaluate(
    ({ filePath, filename }) => {
      const state = window.__store!.getState()
      if (!state.activeWorktreeId) {
        throw new Error('No fixture worktree')
      }
      const fileId = state.openFile({
        filePath,
        relativePath: filename,
        worktreeId: state.activeWorktreeId,
        language: 'xml',
        mode: 'edit'
      })
      state.setMarkdownViewMode(fileId, 'rich')
    },
    { filePath, filename }
  )
  await expect(orcaPage.getByRole('img', { name: filename, exact: true })).toBeVisible()
  await orcaPage.getByRole('button', { name: 'Image actions', exact: true }).click()
  const menu = orcaPage.locator('[data-image-actions-menu][data-state="open"]')
  await expect(menu.getByRole('menuitem')).toHaveCount(5)
  await expect(menu.getByRole('menuitem', { name: 'Copy image path', exact: true })).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Copy image', exact: true }).click()
  await expect
    .poll(() => electronApp.evaluate(() => process.env.ORCA_E2E_SVG_COPY_SIZE))
    .toBe(JSON.stringify({ width: 240, height: 100 }))
})

test('image previews copy, save and route local file actions without closing the popup', async ({
  orcaPage,
  electronApp,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await orcaPage.setViewportSize({ width: 1280, height: 800 })
  const filename = 'image-actions-proof.png'
  const filePath = path.join(seededRepoPath, filename)
  writeFileSync(filePath, Buffer.from(PNG, 'base64'))
  registerPostElectronShutdownCleanup(async () => rmSync(filePath, { force: true }))
  // Keep OS effects isolated while exercising the real file-open IPC handlers.
  await electronApp.evaluate(({ ipcMain, shell }) => {
    for (const channel of [
      'clipboard:writeImage',
      'clipboard:writeText',
      'fs:saveDownloadedFile'
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
    shell.openPath = async (path: string) => {
      process.env.ORCA_E2E_IMAGE_ACTION_OPEN = path
      return ''
    }
    shell.showItemInFolder = (path: string) => {
      process.env.ORCA_E2E_IMAGE_ACTION_REVEAL = path
    }
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
  await orcaPage.getByTestId('pan-zoom-image-canvas').click({ button: 'right' })
  const menu = orcaPage.locator('[data-image-actions-menu][data-state="open"]')
  await expect(menu.getByRole('menuitem')).toHaveCount(5)
  await orcaPage.screenshot({
    path: testInfo.outputPath('image-editor-context-menu.png'),
    animations: 'disabled'
  })
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
  await expect.poll(() => captured('ORCA_E2E_IMAGE_ACTION_REVEAL')).toBe(filePath)
  await openMenu()
  await menu.getByRole('menuitem', { name: 'Open with default app', exact: true }).click()
  await expect.poll(() => captured('ORCA_E2E_IMAGE_ACTION_OPEN')).toBe(filePath)

  await orcaPage.evaluate(
    async ({ repoPath, filename }) => {
      const state = window.__store?.getState()
      if (!state?.activeWorktreeId) {
        throw new Error('No fixture worktree')
      }
      const status = await window.api.git.status({ worktreePath: repoPath })
      state.setGitStatus(state.activeWorktreeId, status)
      state.openAllDiffs(
        state.activeWorktreeId,
        repoPath,
        undefined,
        'untracked',
        status.entries.filter((entry) => entry.path === filename)
      )
    },
    { repoPath: seededRepoPath, filename }
  )
  await orcaPage.getByRole('button', { name: 'Expand image', exact: true }).click()
  const popup = orcaPage.getByRole('dialog', { name: filename, exact: true })
  await expect(popup).toBeVisible()
  await popup.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect(popup.getByRole('img', { name: filename, exact: true })).toHaveCSS('width', '80px')
  await popup.getByTestId('pan-zoom-image-canvas').click({ button: 'right' })
  await expect(menu.getByRole('menuitem')).toHaveCount(2)
  await orcaPage.screenshot({
    path: testInfo.outputPath('image-popup-context-menu.png'),
    animations: 'disabled'
  })
  await menu.getByRole('menuitem', { name: 'Save image as…', exact: true }).click()
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
