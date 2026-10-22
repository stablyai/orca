import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady, ensureTerminalVisible } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture
} from './helpers/markdown-editor-fixture'
import {
  claudeTranscriptLines,
  enableNativeChatSetting,
  seedClaudeProviderSession,
  toggleTerminalTabToChatView
} from './helpers/native-chat-transcript-fixture'

test('opens a Markdown preview beside its source and reuses the side pane', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = await createMarkdownFixture(
    context,
    'preview-side',
    'notes',
    testInfo.workerIndex,
    '# Side preview\n\nMarkdown stays readable beside its source.\n'
  )
  registerPostElectronShutdownCleanup(() => cleanupMarkdownFixture(filePath))
  await openMarkdownFixture(orcaPage, context, filePath)
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    if (state.activeFileId) {
      state.setMarkdownViewMode(state.activeFileId, 'source')
    }
  })
  const source = orcaPage.locator('.monaco-editor').filter({ visible: true })
  await expect(source).toBeVisible()
  const open = orcaPage.getByRole('button', { name: 'Open Preview to the Side', exact: true })
  await open.click()
  await expect(orcaPage.getByRole('heading', { name: 'Side preview', exact: true })).toBeVisible()
  await expect(source).toBeVisible()
  await open.click()
  await expect(orcaPage.getByRole('heading', { name: 'Side preview', exact: true })).toHaveCount(1)
  await orcaPage.screenshot({ path: testInfo.outputPath('markdown-source-and-preview.png') })
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
    )
  ).toBe(true)
})

test('opens an assistant-linked Markdown preview beside Chat', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = await createMarkdownFixture(
    context,
    'preview-side',
    'report',
    testInfo.workerIndex,
    '# Chat report\n\nA generic preview fixture.\n'
  )
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId] = descriptor.paneKey.split(':')
  const sessionId = `preview-side-${randomUUID()}`
  const transcriptPath = path.join(path.dirname(filePath), `${sessionId}.jsonl`)
  writeFileSync(
    transcriptPath,
    claudeTranscriptLines({
      sessionId,
      userText: 'Show the report.',
      assistantText: `[Open report](${filePath})`
    })
  )
  registerPostElectronShutdownCleanup(async () => {
    await cleanupMarkdownFixture(filePath)
    await cleanupMarkdownFixture(transcriptPath)
  })
  await enableNativeChatSetting(orcaPage)
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({ terminalLinkClickBehavior: 'actions' })
  })
  await seedClaudeProviderSession(orcaPage, {
    paneKey: descriptor.paneKey,
    worktreeId: descriptor.worktreeId,
    sessionId,
    transcriptPath
  })
  await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })
  const chat = orcaPage.locator('[data-native-chat-root="true"]')
  await chat.getByRole('link', { name: 'Open report', exact: true }).click()
  await orcaPage
    .locator('[data-link-action-popover]')
    .getByRole('button', { name: 'Open Preview to the Side', exact: true })
    .click()
  await expect(orcaPage.getByRole('heading', { name: 'Chat report', exact: true })).toBeVisible()
  await expect(chat.getByRole('link', { name: 'Open report', exact: true })).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('chat-and-markdown-preview.png') })
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
    )
  ).toBe(true)
})
