import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const RESTORE_CLIPBOARD = 'e2e:restore-explorer-image-clipboard'

for (const source of ['fixture', 'system'] as const) {
  test(`pastes a ${source} clipboard image into the explorer without overwriting`, async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    test.skip(
      source === 'system' && process.env.ORCA_E2E_SYSTEM_CLIPBOARD_IMAGE !== '1',
      'System clipboard writes require an explicit local opt-in.'
    )
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await openFileExplorer(orcaPage)
    const worktreePath = await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      const worktree = Object.values(state?.worktreesByRepo ?? {})
        .flat()
        .find((candidate) => candidate.id === state?.activeWorktreeId)
      if (!worktree) {
        throw new Error('Active test worktree unavailable')
      }
      return worktree.path
    })
    const row = (name: string) =>
      orcaPage
        .locator('[data-file-explorer-row]')
        .filter({ has: orcaPage.getByText(name, { exact: true }) })
    const folderName = `image-paste-${source}`
    const destination = path.join(worktreePath, folderName)
    await mkdir(destination)
    const folder = row(folderName)
    await expect(folder).toBeVisible()

    const expectedPng = await electronApp.evaluate(
      ({ clipboard, nativeImage, ipcMain }, args) => {
        const image = nativeImage.createFromBitmap(
          Buffer.from([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0]),
          { width: 2, height: 2 }
        )
        if (image.isEmpty()) {
          throw new Error('Invalid test PNG')
        }
        if (args.source === 'system') {
          const formats = clipboard.availableFormats()
          if (formats.some((format) => format !== 'text/plain')) {
            throw new Error(
              'Native clipboard check requires an empty or plain-text clipboard to restore it safely.'
            )
          }
          const originalText = clipboard.readText()
          const wasEmpty = formats.length === 0
          clipboard.writeImage(image)
          const written = clipboard.readImage().toPNG()
          ipcMain.once(args.restoreEvent, () => {
            // Preserve anything the user copied while the test was running.
            if (!clipboard.readImage().toPNG().equals(written) || clipboard.readText()) {
              return
            }
            if (wasEmpty) {
              clipboard.clear()
            } else {
              clipboard.writeText(originalText)
            }
          })
          return written.toString('base64')
        }
        const original = {
          readImage: clipboard.readImage,
          availableFormats: clipboard.availableFormats,
          readBuffer: clipboard.readBuffer,
          has: clipboard.has
        }
        // Only replace OS reads; staging, IPC, import and filesystem remain real.
        clipboard.readImage = () => image
        clipboard.availableFormats = () => ['image/png']
        clipboard.readBuffer = () => Buffer.alloc(0)
        clipboard.has = (format) => format === 'image/png'
        ipcMain.once(args.restoreEvent, () => Object.assign(clipboard, original))
        return image.toPNG().toString('base64')
      },
      { source, restoreEvent: RESTORE_CLIPBOARD }
    )

    try {
      await folder.click()
      const chord = process.platform === 'darwin' ? 'Meta+v' : 'Control+v'
      await folder.press(chord)
      const created = row('pasted-image.png')
      await expect(created).toBeVisible()
      await expect(created).toHaveAttribute('data-selected', 'true')
      const firstPath = path.join(destination, 'pasted-image.png')
      const expected = Buffer.from(expectedPng, 'base64')
      expect(await readFile(firstPath)).toEqual(expected)

      await created.click({ button: 'right' })
      await orcaPage.getByRole('menuitem', { name: /Paste Image/ }).click()
      await expect(row('pasted-image copy.png')).toBeVisible()
      await expect(row('pasted-image copy.png')).toHaveAttribute('data-selected', 'true')
      expect(await readFile(firstPath)).toEqual(expected)
      expect(await readFile(path.join(destination, 'pasted-image copy.png'))).toEqual(expected)
      expect(
        (await readdir(destination)).filter((name) => name.startsWith('pasted-image')).sort()
      ).toEqual(['pasted-image copy.png', 'pasted-image.png'])
      const artifactPath = testInfo.outputPath('pasted-image.png')
      await copyFile(firstPath, artifactPath)
      await testInfo.attach('pasted-image.png', { path: artifactPath, contentType: 'image/png' })
      await orcaPage.keyboard.press('Escape')
      await expect(orcaPage.getByRole('menuitem', { name: /Paste Image/ })).toBeHidden()
      await orcaPage.screenshot({ path: testInfo.outputPath('explorer-pasted-image.png') })
    } finally {
      await electronApp.evaluate(({ ipcMain }, event) => {
        ipcMain.emit(event)
      }, RESTORE_CLIPBOARD)
    }
  })
}
