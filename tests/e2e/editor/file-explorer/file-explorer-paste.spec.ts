import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { openFileExplorer } from './file-explorer'
import { expect } from '@stablyai/playwright-test'

test.use({ seedTestRepo: false })

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const FILE_NAME = 'clipboard-source.txt'
const CONTENT = 'pasted into the selected folder\n'

test('pastes clipboard files and images into the selected folder', async ({
  orcaPage: page,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'orca-file-paste-')))
  registerPostElectronShutdownCleanup(() => rm(tempRoot, { recursive: true, force: true }))
  const workspace = path.join(tempRoot, 'workspace')
  const destination = path.join(workspace, 'destination')
  const sourceFile = path.join(tempRoot, FILE_NAME)
  await mkdir(destination, { recursive: true })
  await writeFile(sourceFile, CONTENT)

  await page.evaluate(async (workspacePath) => {
    await window.__store!.getState().addRepoPath(workspacePath, 'folder')
  }, workspace)
  await page.getByRole('option').filter({ hasText: 'workspace' }).click()
  await openFileExplorer(page)

  const shell = page.locator('[data-orca-explorer-shell]')
  const destinationRow = shell.getByRole('button', { name: 'destination', exact: true })
  await expect(destinationRow).toBeVisible()
  await destinationRow.click()
  await page.screenshot({ path: testInfo.outputPath('before.png') })

  await electronApp.evaluate(({ clipboard, nativeImage }, image) => {
    clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(image, 'base64')))
  }, PNG_BASE64)
  await expect.poll(() => page.evaluate(() => window.api.ui.clipboardHasImage())).toBe(true)

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
  await expect
    .poll(async () => {
      const files = await readdir(destination)
      if (files.length === 0) {
        return null
      }
      const image = await readFile(path.join(destination, files[0]))
      return image.subarray(0, 8).toString('hex')
    })
    .toBe('89504e470d0a1a0a')

  await electronApp.evaluate(
    ({ clipboard }, file) => {
      clipboard.write({ text: file.name })
      clipboard.writeBuffer('text/uri-list', Buffer.from(`${file.url}\r\n`))
    },
    { name: FILE_NAME, url: pathToFileURL(sourceFile).href }
  )
  await expect
    .poll(() => page.evaluate(() => window.api.ui.readClipboardFilePaths()))
    .toContain(sourceFile)
  await destinationRow.focus()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
  await expect
    .poll(() => readFile(path.join(destination, FILE_NAME), 'utf8').catch(() => null))
    .toBe(CONTENT)
  await expect.poll(() => readdir(destination)).toHaveLength(2)
  await expect(shell.getByRole('button', { name: FILE_NAME, exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('after.png') })
})
