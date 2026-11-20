import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { openFileExplorer } from './file-explorer'
import { expect, type Locator, type Page } from '@stablyai/playwright-test'

test.use({ seedTestRepo: false })
test.skip(process.platform !== 'linux', 'File clipboard test writes Linux text/uri-list format')

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const FILE_NAME = 'clipboard-source.txt'
const CONTENT = 'pasted into the selected folder\n'
const RECORDING = process.env.ORCA_E2E_RECORD_VIDEO === '1'
let videoMousePosition = { x: 30, y: 80 }

async function showVideoCursor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const style = document.createElement('style')
    style.textContent = `
      #orca-e2e-video-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; width: 27px; height: 37px; pointer-events: none; transform: translate(-40px, -40px); }
      #orca-e2e-video-cursor svg { display: block; filter: drop-shadow(0 1px 1px rgb(0 0 0 / 65%)); }
      #orca-e2e-video-cursor[data-pressed="true"]::after { content: ""; position: absolute; left: 2px; top: 2px; width: 24px; height: 24px; border: 2px solid #f97316; border-radius: 9999px; transform: translate(-7px, -7px); }
    `
    const cursor = document.createElement('div')
    cursor.id = 'orca-e2e-video-cursor'
    cursor.innerHTML =
      '<svg viewBox="0 0 24 32" aria-hidden="true"><path d="M2 2v24l6.5-6.3 4.2 9.1 4-1.9-4.2-8.8H22L2 2Z" fill="white" stroke="#171717" stroke-width="1.8" stroke-linejoin="round"/></svg>'
    document.head.append(style)
    document.body.append(cursor)
    window.addEventListener('pointermove', (event) => {
      cursor.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`
    })
    window.addEventListener('pointerdown', () => cursor.setAttribute('data-pressed', 'true'), true)
    window.addEventListener('pointerup', () => cursor.removeAttribute('data-pressed'), true)
  })
  await page.mouse.move(30, 80)
  videoMousePosition = { x: 30, y: 80 }
}

async function moveAndClick(
  page: Page,
  locator: Locator,
  button: 'left' | 'right' = 'left'
): Promise<void> {
  const box = await locator.boundingBox()
  if (!box) {
    throw new Error('Cannot move the video cursor to an invisible element')
  }
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const steps = RECORDING ? 24 : 8
  // ast-grep-ignore: test-no-polling-loop -- paced cursor steps make the requested recording easy to follow.
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps
    await page.mouse.move(
      videoMousePosition.x + (x - videoMousePosition.x) * progress,
      videoMousePosition.y + (y - videoMousePosition.y) * progress
    )
    if (RECORDING) {
      // ast-grep-ignore: test-no-real-time-wait -- recording-only pause separates cursor steps visually.
      await page.waitForTimeout(45)
    }
  }
  videoMousePosition = { x, y }
  if (RECORDING) {
    // ast-grep-ignore: test-no-real-time-wait -- recording-only pause lets the viewer track the target before the click.
    await page.waitForTimeout(450)
  }
  await page.mouse.click(x, y, { button, delay: RECORDING ? 650 : 0 })
  if (RECORDING) {
    // ast-grep-ignore: test-no-real-time-wait -- recording-only pause keeps the click result visible.
    await page.waitForTimeout(500)
  }
}

async function rightClickPaste(page: Page, target: Locator): Promise<void> {
  await moveAndClick(page, target, 'right')
  const paste = page.getByRole('menuitem', { name: /^Paste(?:\s|$)/ })
  await expect(paste).toBeVisible()
  await moveAndClick(page, paste)
}

test('pastes clipboard files and images through the explorer context menus', async ({
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
  await page.setViewportSize({ width: 1920, height: 1080 })

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
  if (RECORDING) {
    await showVideoCursor(page)
  }

  await electronApp.evaluate(({ clipboard, nativeImage }, image) => {
    clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(image, 'base64')))
  }, PNG_BASE64)
  await expect.poll(() => page.evaluate(() => window.api.ui.clipboardHasImage())).toBe(true)

  await rightClickPaste(page, destinationRow)
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
  await rightClickPaste(page, destinationRow)
  await expect
    .poll(() => readFile(path.join(destination, FILE_NAME), 'utf8').catch(() => null))
    .toBe(CONTENT)
  await expect.poll(() => readdir(destination)).toHaveLength(2)
  await expect(shell.getByRole('button', { name: FILE_NAME, exact: true })).toBeVisible()

  await rightClickPaste(page, shell.locator('[data-slot="scroll-area-viewport"]'))
  await expect
    .poll(() => readFile(path.join(workspace, FILE_NAME), 'utf8').catch(() => null))
    .toBe(CONTENT)
  await expect(shell.getByRole('button', { name: FILE_NAME, exact: true })).toHaveCount(2)
  await page.screenshot({ path: testInfo.outputPath('after.png') })
})
