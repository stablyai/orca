import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'

test('Copy image puts the full-size image on the clipboard and keeps the preview open', async ({
  orcaPage,
  electronApp,
  testRepoPath
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  // Why two sizes: the chip previews the pasted image while the copy must read the saved file,
  // so an 800x600 copy proves the file was read, not the 64x64 preview.
  const [png, pastedPng] = await electronApp.evaluate(({ nativeImage }) =>
    [800, 64].map((width) => {
      const height = (width * 3) / 4
      return nativeImage
        .createFromBitmap(Buffer.alloc(width * height * 4, 200), { width, height })
        .toPNG()
        .toString('base64')
    })
  )
  // Why the repo: previews only read files under allowed roots; the test output dir isn't one.
  const imageName = `copy-image-proof-${randomUUID()}.png`
  const imagePath = path.join(testRepoPath, imageName)
  await writeFile(imagePath, Buffer.from(png, 'base64'))
  try {
    // Substitute only the clipboard IPC; never touch the user's system clipboard.
    await electronApp.evaluate(
      ({ ipcMain, nativeImage }, { imagePath }) => {
        ipcMain.removeHandler('clipboard:saveImageAsTempFile')
        ipcMain.handle('clipboard:saveImageAsTempFile', () => imagePath)
        ipcMain.removeHandler('clipboard:writeImage')
        ipcMain.handle('clipboard:writeImage', (_event, dataUrl: string) => {
          const { width, height } = nativeImage.createFromDataURL(dataUrl).getSize()
          process.env.ORCA_E2E_COPIED_IMAGE_SIZE = `${width}x${height}`
        })
      },
      { imagePath }
    )
    const takeCopiedImageSize = (): Promise<string | null> =>
      electronApp.evaluate(() => {
        const size = process.env.ORCA_E2E_COPIED_IMAGE_SIZE ?? null
        delete process.env.ORCA_E2E_COPIED_IMAGE_SIZE
        return size
      })
    await orcaPage.evaluate(async ({ paneKey, worktreeId }) => {
      const settings = await window.api.settings.set({ experimentalNativeChat: true })
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      store.setState({ settings })
      const state = store.getState()
      state.setAgentStatus(
        paneKey,
        { state: 'done', agentType: 'omp', prompt: '' },
        'OMP',
        undefined,
        { worktreeId }
      )
      const [tabId] = paneKey.split(':')
      const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tabId
      )
      if (!tab) {
        throw new Error('Terminal tab unavailable')
      }
      state.toggleTabViewMode(tab.id)
    }, descriptor)
    const composer = orcaPage.getByRole('textbox', {
      name: 'Ask anything, @ to mention files, / for commands',
      exact: true
    })
    await expect(composer).toBeVisible()
    await composer.evaluate((element, png) => {
      const data = new DataTransfer()
      const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0))
      data.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }))
      element.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
      )
    }, pastedPng)
    const thumbnail = orcaPage.getByRole('button', { name: `View image: ${imageName}` })
    await expect(thumbnail).toHaveAttribute('data-native-chat-copy-image-src', /^blob:/)
    const copyImage = orcaPage.getByRole('menuitem', { name: 'Copy image' })

    await thumbnail.click({ button: 'right' })
    await copyImage.click()
    await expect.poll(takeCopiedImageSize).toBe('800x600')

    await thumbnail.click()
    const preview = orcaPage.getByRole('dialog')
    const fullSize = preview.getByRole('img', { name: imageName })
    await fullSize.click({ button: 'right' })
    await copyImage.click()
    await expect.poll(takeCopiedImageSize).toBe('800x600')
    // Why: the preview's dismissal fires on that click, so once the menu has fully left the page
    // a dismissed preview would already read data-state="closed".
    await expect(orcaPage.getByRole('menu')).toHaveCount(0)
    await expect(preview).toHaveAttribute('data-state', 'open')

    await fullSize.click({ button: 'right' })
    await expect(copyImage).toBeVisible()
    await preview.getByRole('button', { name: 'Close' }).click()
    await expect(preview).toHaveCount(0)
  } finally {
    await rm(imagePath, { force: true })
  }
})
