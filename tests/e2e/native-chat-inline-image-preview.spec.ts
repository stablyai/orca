import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import {
  claudeTranscriptLines,
  enableNativeChatSetting,
  seedClaudeProviderSession,
  toggleTerminalTabToChatView
} from './helpers/native-chat-transcript-fixture'

test.use({ orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

const sourceImage = path.resolve(
  __dirname,
  '..',
  '..',
  'docs',
  'site',
  'public',
  'docs',
  'ways-to-run-run-on.png'
)

function transcript(sessionId: string, imagePath: string): string {
  return claudeTranscriptLines({
    sessionId,
    userText: 'Show the inline image preview.',
    assistantText: [
      'The table uses the actual local image source:',
      '',
      '| Preview | Details |',
      '| --- | --- |',
      `| ![Inline chat screenshot](${imagePath}) | [Ordinary file link](${imagePath}) |`
    ].join('\n')
  })
}

test('opens a native-chat Markdown table image in the image dialog without a file popup', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo) => {
  expect(existsSync(sourceImage)).toBe(true)
  const imagePath = path.join(testRepoPath, `inline-chat-preview-${randomUUID()}.png`)
  const sessionId = `e2e-inline-image-${randomUUID()}`
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-inline-image-'))
  const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
  copyFileSync(sourceImage, imagePath)

  try {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const [tabId] = descriptor.paneKey.split(':')
    writeFileSync(transcriptPath, transcript(sessionId, imagePath))
    await enableNativeChatSetting(orcaPage)
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ terminalLinkClickBehavior: 'actions' })
    })
    await seedClaudeProviderSession(orcaPage, {
      paneKey: descriptor.paneKey,
      worktreeId: descriptor.worktreeId,
      sessionId,
      transcriptPath
    })
    await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })

    const chat = orcaPage.locator('[data-native-chat-root="true"]')
    const image = chat.getByRole('button', { name: 'View image: Inline chat screenshot' })
    await expect(image).toBeVisible({ timeout: 30_000 })
    const ordinaryFileLink = chat.getByRole('link', { name: 'Ordinary file link' })
    await expect(ordinaryFileLink).toBeVisible()
    await chat
      .locator('table')
      .screenshot({ path: testInfo.outputPath('01-table-image-light.png') })

    await ordinaryFileLink.click()
    const ordinaryFilePopup = orcaPage.locator('[data-link-action-popover]')
    await expect(ordinaryFilePopup).toBeVisible()
    await expect(ordinaryFilePopup).toContainText(imagePath)
    await expect(ordinaryFilePopup.getByRole('button', { name: 'Open file' })).toBeVisible()
    await ordinaryFilePopup.screenshot({
      path: testInfo.outputPath('02-ordinary-file-popup-light.png')
    })
    await orcaPage.keyboard.press('Escape')
    await expect(ordinaryFilePopup).toHaveCount(0)
    await expect(ordinaryFileLink).toBeFocused()

    await image.click()
    const dialog = orcaPage.getByRole('dialog', { name: 'Inline chat screenshot' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('img', { name: 'Inline chat screenshot' })).toBeVisible()
    await expect(ordinaryFilePopup).toHaveCount(0)
    await expect(orcaPage.getByRole('menu')).toHaveCount(0)
    await dialog.screenshot({ path: testInfo.outputPath('03-image-dialog-light.png') })

    const zoomIn = dialog.getByRole('button', { name: 'Zoom in' })
    await expect(zoomIn).toBeEnabled()
    await zoomIn.click()
    await expect(dialog.getByRole('button', { name: 'Fit to screen' })).toBeEnabled()
    const actions = dialog.getByRole('button', { name: 'File actions' })
    await expect(actions).toBeVisible()
    await actions.click()
    await expect(orcaPage.getByRole('menu')).toBeVisible()
    await dialog.screenshot({ path: testInfo.outputPath('04-image-dialog-actions-light.png') })
    await orcaPage.keyboard.press('Escape')
    await expect(orcaPage.getByRole('menu')).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(image).toBeFocused()

    await image.focus()
    await orcaPage.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(image).toBeFocused()

    await image.focus()
    await orcaPage.keyboard.press('Space')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(image).toBeFocused()

    await orcaPage.evaluate(() => document.documentElement.classList.add('dark'))
    await image.click()
    await expect(dialog).toBeVisible()
    await dialog.screenshot({ path: testInfo.outputPath('05-image-dialog-dark.png') })
    await orcaPage.setViewportSize({ width: 480, height: 560 })
    await expect(dialog).toBeVisible()
    await dialog.screenshot({ path: testInfo.outputPath('06-image-dialog-dark-narrow.png') })
    await orcaPage.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    const windows = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        focused: window.isFocused()
      }))
    )
    expect(windows.length).toBeGreaterThan(0)
    expect(windows.every((window) => !window.visible && !window.focused)).toBe(true)
  } finally {
    rmSync(imagePath, { force: true })
    rmSync(scratchDir, { recursive: true, force: true })
  }
})
