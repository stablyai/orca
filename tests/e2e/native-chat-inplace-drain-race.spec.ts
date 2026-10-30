import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import {
  claudeTranscriptLines,
  enableNativeChatSetting,
  seedClaudeProviderSession,
  toggleTerminalTabToChatView
} from './helpers/native-chat-transcript-fixture'

test('renders a larger transcript rewrite during snapshot publication, then ordinary appends', async ({
  electronApp,
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId] = descriptor.paneKey.split(':')
  const sessionId = `drain-race-${randomUUID()}`
  const root = mkdtempSync(join(tmpdir(), 'orca-native-chat-drain-proof-'))
  registerPostElectronShutdownCleanup(async () => rmSync(root, { recursive: true, force: true }))
  const transcriptPath = join(root, `${sessionId}.jsonl`)
  const cleanupChannel = `e2e:drain-race-cleanup:${sessionId}`
  const oldText = 'Original transcript before replacement'
  const newText = 'Replacement transcript written while the original snapshot was being published'
  writeFileSync(
    transcriptPath,
    claudeTranscriptLines({
      sessionId,
      messageIdPrefix: 'old',
      userText: 'Original question',
      assistantText: oldText
    })
  )
  const replacement = claudeTranscriptLines({
    sessionId,
    messageIdPrefix: 'new',
    userText: 'The transcript was replaced during publication. Can you show the new conversation?',
    assistantText: newText
  })
  // Force the observed ordering on the real host; leave IPC delivery and renderer handling intact.
  await electronApp.evaluate(
    ({ BrowserWindow, ipcMain }, args) => {
      const fs = process.getBuiltinModule('fs')
      const contents = BrowserWindow.getAllWindows()[0]?.webContents
      if (!contents) {
        throw new Error('Renderer unavailable')
      }
      const send = contents.send
      ipcMain.once(args.cleanupChannel, () => {
        contents.send = send
      })
      contents.send = function (channel: string, ...values: unknown[]): void {
        send.call(this, channel, ...values)
        const payload = values[0]
        if (
          channel !== 'nativeChat:appended' ||
          !payload ||
          typeof payload !== 'object' ||
          !('frame' in payload)
        ) {
          return
        }
        const frame = payload.frame
        if (
          !frame ||
          typeof frame !== 'object' ||
          !('messages' in frame) ||
          !Array.isArray(frame.messages)
        ) {
          return
        }
        if (
          frame.messages.some(
            (message: unknown) =>
              message && typeof message === 'object' && 'id' in message && message.id === 'old-user'
          )
        ) {
          contents.send = send
          fs.writeFileSync(args.transcriptPath, args.replacement)
        }
      }
    },
    { transcriptPath, replacement, cleanupChannel }
  )

  const transcript = orcaPage.locator('[data-native-chat-root="true"]')
  async function capture(name: string): Promise<void> {
    const bounds = await transcript.boundingBox()
    if (!bounds) {
      throw new Error('Chat transcript has no rendered bounds')
    }
    await orcaPage.screenshot({
      path: testInfo.outputPath(name),
      clip: { ...bounds, height: Math.min(bounds.height, 320) }
    })
  }
  try {
    await enableNativeChatSetting(orcaPage)
    await seedClaudeProviderSession(orcaPage, { ...descriptor, sessionId, transcriptPath })
    await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })
    await expect(transcript).toBeVisible()
    try {
      await expect(transcript.getByText(newText)).toBeVisible({ timeout: 8_000 })
      await expect(transcript.getByText(oldText)).toHaveCount(0)
    } finally {
      await capture('after-drain.png')
    }
    const followup = 'Ordinary appended messages still arrive exactly once.'
    appendFileSync(
      transcriptPath,
      claudeTranscriptLines({
        sessionId,
        messageIdPrefix: 'followup',
        userText: 'Continue',
        assistantText: followup
      })
    )
    await expect(transcript.getByText(followup)).toBeVisible()
    await expect(transcript.getByText(followup)).toHaveCount(1)
    await capture('after-followup.png')
  } finally {
    await electronApp.evaluate(({ ipcMain }, channel) => {
      ipcMain.emit(channel)
    }, cleanupChannel)
  }
})
