import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { filesystemPathToFileUri } from '../../src/shared/file-uri-path'
import { isWindowsAbsolutePathLike } from '../../src/shared/cross-platform-path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import {
  claudeTranscriptLines,
  enableNativeChatSetting,
  seedClaudeProviderSession,
  toggleTerminalTabToChatView
} from './helpers/native-chat-transcript-fixture'

test('chat sandbox images render and file links open on their session owner', async ({
  orcaPage,
  electronApp,
  testRepoPath
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({ uiLanguage: 'en' })
  })
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId] = descriptor.paneKey.split(':')
  if (!tabId) {
    throw new Error('Chat terminal tab is unavailable')
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'orca-sandbox-chat-'))
  const prefix = `sandbox-${randomUUID()}`
  const pngPath = path.join(testRepoPath, `${prefix}.png`).replaceAll('\\', '/')
  const pdfPath = path.join(testRepoPath, `${prefix}.pdf`).replaceAll('\\', '/')
  const csvPath = path.join(testRepoPath, `${prefix}.csv`).replaceAll('\\', '/')
  const svgPath = path.join(testRepoPath, `${prefix}.svg`).replaceAll('\\', '/')
  const missingPath = path.join(testRepoPath, `${prefix}-missing.png`).replaceAll('\\', '/')
  const generated = await electronApp.evaluate(async ({ nativeImage, BrowserWindow }) => {
    const bitmap = Buffer.alloc(400 * 120 * 4)
    for (let y = 0; y < 120; y++) {
      for (let x = 0; x < 400; x++) {
        const offset = (y * 400 + x) * 4
        const bar = x > 25 && x < 375 && y > 25 && y < 95
        bitmap[offset] = bar ? 180 : 240
        bitmap[offset + 1] = bar ? 100 : 240
        bitmap[offset + 2] = bar ? 30 : 240
        bitmap[offset + 3] = 255
      }
    }
    const png = nativeImage
      .createFromBitmap(bitmap, { width: 400, height: 120 })
      .toPNG()
      .toString('base64')
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    try {
      await window.loadURL('data:text/html,<h1>Generated PDF</h1><p>Round 1: 97.1 percent</p>')
      return { png, pdf: (await window.webContents.printToPDF({})).toString('base64') }
    } finally {
      window.destroy()
    }
  })
  try {
    await Promise.all([
      writeFile(pngPath, Buffer.from(generated.png, 'base64')),
      writeFile(pdfPath, Buffer.from(generated.pdf, 'base64')),
      writeFile(csvPath, 'round,score\n1,97.1\n'),
      writeFile(
        svgPath,
        '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120"><rect width="400" height="120" fill="gray"/><text x="20" y="65">Generated chart</text></svg>'
      )
    ])
    const sessionId = `sandbox-e2e-${randomUUID()}`
    const transcriptPath = path.join(scratch, `${sessionId}.jsonl`)
    // Sandbox paths are POSIX; Windows still exercises every action with a native file URI.
    const reference = (file: string): string =>
      isWindowsAbsolutePathLike(file) ? filesystemPathToFileUri(file) : `sandbox:${encodeURI(file)}`
    await writeFile(
      transcriptPath,
      claudeTranscriptLines({
        sessionId,
        userText: 'Show the generated report.',
        assistantText: `Generated files are ready.\n\n![Generated PNG](${reference(pngPath)})\n\n![Missing image](${reference(missingPath)})\n\n[Download PDF](${reference(pdfPath)}) · [Download SVG](${reference(svgPath)}) · [Download CSV](${reference(csvPath)})`
      })
    )
    await enableNativeChatSetting(orcaPage)
    await seedClaudeProviderSession(orcaPage, { ...descriptor, sessionId, transcriptPath })
    await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })
    const chat = orcaPage.locator('[data-native-chat-root="true"]')
    await expect(chat.getByText('Generated files are ready.')).toBeVisible()
    await chat
      .locator('.native-chat-markdown')
      .last()
      .screenshot({
        path: testInfo.outputPath('sandbox-render-before-image-check.png')
      })
    const image = chat.getByRole('img', { name: 'Generated PNG', exact: true })
    await expect(image).toHaveJSProperty('naturalWidth', 400)
    await expect(image).toBeVisible()
    const previousImageSrc = await image.getAttribute('src')
    if (!previousImageSrc) {
      throw new Error('The chat image has no resource URL')
    }
    // Refresh the cache without activating a native window.
    await orcaPage.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(image).not.toHaveAttribute('src', previousImageSrc)
    await expect(image).toHaveJSProperty('naturalWidth', 400)
    await image.evaluate(async (element) => {
      if (!(element instanceof HTMLImageElement)) {
        throw new Error('The chat preview is not an image')
      }
      await element.decode()
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
    })
    await expect(chat.getByText(/Couldn't preview image/)).toBeVisible()
    await chat
      .locator('.native-chat-markdown')
      .last()
      .screenshot({ path: testInfo.outputPath('sandbox-render-loaded.png') })
    await image.click()
    await expect(
      orcaPage.getByRole('dialog').getByRole('img', { name: 'Generated PNG', exact: true })
    ).toHaveJSProperty('naturalWidth', 400)
    await orcaPage.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
    for (const [name, file] of [
      ['PDF', pdfPath],
      ['SVG', svgPath],
      ['CSV', csvPath]
    ] as const) {
      await chat
        .getByRole('link', { name: `Download ${name}`, exact: true })
        .click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })
      await expect
        .poll(() =>
          orcaPage.evaluate(
            (filePath) =>
              window.__store
                ?.getState()
                .openFiles.some((file) => file.filePath.replaceAll('\\', '/') === filePath),
            file
          )
        )
        .toBe(true)
      if (name === 'PDF') {
        await expect(orcaPage.locator('.pdfViewer canvas').first()).toBeVisible()
      } else if (name === 'SVG') {
        const chart = orcaPage.getByRole('img', { name: path.basename(svgPath), exact: true })
        await expect(chart).toBeVisible()
        await expect(chart).toHaveJSProperty('naturalWidth', 400)
        await expect(chart).toHaveJSProperty('naturalHeight', 120)
        await expect
          .poll(() =>
            chart.evaluate(async (image) => {
              if (!(image instanceof HTMLImageElement)) {
                throw new Error('Missing SVG image')
              }
              return (await (await fetch(image.currentSrc)).text()).includes('Generated chart')
            })
          )
          .toBe(true)
      } else {
        const grid = orcaPage.getByTestId('csv-grid')
        await expect(grid).toBeVisible()
        await expect(grid.getByText('round', { exact: true })).toBeVisible()
        await expect(grid.getByText('score', { exact: true })).toBeVisible()
        await expect(grid.getByText('97.1', { exact: true })).toBeVisible()
      }
      await orcaPage.evaluate(
        ({ tabId, worktreeId }) => {
          const state = window.__store?.getState()
          const tab = state?.unifiedTabsByWorktree[worktreeId]?.find(
            (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tabId
          )
          if (!tab || !state) {
            throw new Error('The source chat tab disappeared')
          }
          state.setActiveTab(tab.id)
        },
        { tabId, worktreeId: descriptor.worktreeId }
      )
    }
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused())
      )
    ).toBe(false)
  } finally {
    await rm(scratch, { recursive: true, force: true })
    await Promise.all([pngPath, pdfPath, csvPath, svgPath].map((file) => rm(file, { force: true })))
  }
})
