import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import {
  enableExperimentalNativeChat,
  seedNativeChatProviderSession,
  toggleTerminalTabToNativeChat
} from './helpers/native-chat'

const LOADING_TITLE = 'Loading conversation…'
const ERROR_TITLE = 'Could not load conversation'

function claudeTranscriptLines(args: {
  sessionId: string
  userText: string
  assistantText: string
}): string {
  // Why: distinct timestamps keep the rendered order deterministic (a tie is
  // broken by uuid, which would put the assistant turn first).
  const userTime = new Date()
  const assistantTime = new Date(userTime.getTime() + 2_000)
  const lines = [
    {
      sessionId: args.sessionId,
      uuid: `${args.sessionId}-user`,
      timestamp: userTime.toISOString(),
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: args.userText }] }
    },
    {
      sessionId: args.sessionId,
      uuid: `${args.sessionId}-assistant`,
      timestamp: assistantTime.toISOString(),
      type: 'assistant',
      message: { model: 'claude-opus-4', content: [{ type: 'text', text: args.assistantText }] }
    }
  ]
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
}

test.describe('Native chat first-flush transcript race (#8401)', () => {
  test('stays in loading (never errors) until a not-yet-flushed transcript appears, then hydrates live', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const [tabId] = descriptor.paneKey.split(':')
    const sessionId = `e2e-first-flush-${randomUUID()}`

    // Why: a real Claude Code session flushes its first JSONL line up to
    // minutes after launch (#8401) — this directory intentionally has no file
    // yet when the pane resolves its providerSession.
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-native-chat-'))
    const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)

    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `native-chat-first-flush-race-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })

    try {
      await enableExperimentalNativeChat(orcaPage)
      await seedNativeChatProviderSession(orcaPage, {
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId,
        status: {
          state: 'working',
          prompt: 'e2e first-flush race probe',
          agentType: 'claude'
        },
        terminalTitle: 'Claude',
        providerSession: { id: sessionId, transcriptPath }
      })
      await toggleTerminalTabToNativeChat(orcaPage, {
        tabId,
        worktreeId: descriptor.worktreeId
      })

      await expect(orcaPage.locator('[data-native-chat-root="true"]')).toBeVisible({
        timeout: 15_000
      })
      await expect(orcaPage.getByText(LOADING_TITLE)).toBeVisible({ timeout: 10_000 })
      await expect(orcaPage.getByText(ERROR_TITLE)).toHaveCount(0)
      await orcaPage.screenshot({
        path: path.join(screenshotDir, '01-loading-no-error.png')
      })

      // Why: a short real delay proves the first readSession attempt already
      // hit the not-yet-flushed file (returning notFound) and the renderer's
      // backoff retry — not a lucky first read — is what picks it up below.
      await orcaPage.waitForTimeout(1_500)
      await expect(orcaPage.getByText(ERROR_TITLE)).toHaveCount(0)

      const userText = 'Explain the native chat first-flush race fix for #8401'
      const assistantText =
        'The main process now retries a not-yet-flushed transcript instead of caching a permanent miss.'
      writeFileSync(transcriptPath, claudeTranscriptLines({ sessionId, userText, assistantText }))

      await expect(orcaPage.getByText(userText)).toBeVisible({ timeout: 30_000 })
      await expect(orcaPage.getByText(assistantText)).toBeVisible({ timeout: 30_000 })
      await expect(orcaPage.getByText(ERROR_TITLE)).toHaveCount(0)
      await orcaPage.screenshot({
        path: path.join(screenshotDir, '02-hydrated.png')
      })
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })
})
