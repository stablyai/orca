import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import {
  observeTranscriptPaneLifetime,
  seedClaudeProviderSession,
  toggleTerminalTabToChatView,
  claudeTranscriptLines
} from './helpers/native-chat-transcript-fixture'

const LOADING_TITLE = 'Loading conversation…'
const ERROR_TITLE = 'Could not load conversation'

test.describe('Native chat first-flush transcript race (#8401)', () => {
  test('stays in loading (never errors) until a not-yet-flushed transcript appears, then hydrates live', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const boundPane = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 15_000)
    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    expect(descriptor.paneKey).toBe(`${boundPane.tabId}:${boundPane.activeLeafId}`)
    const [tabId] = descriptor.paneKey.split(':')
    const sessionId = `e2e-first-flush-${randomUUID()}`

    // #8401: Claude may flush its first JSONL minutes after launch; resolve providerSession before creating the file.
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-native-chat-'))
    const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)

    const screenshotDir = testInfo.outputPath('screenshots')
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })

    const finishLifetime = await observeTranscriptPaneLifetime(orcaPage, {
      tabId,
      worktreeId: descriptor.worktreeId,
      paneKey: descriptor.paneKey
    })
    try {
      await seedClaudeProviderSession(orcaPage, {
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId,
        sessionId,
        transcriptPath
      })
      await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })

      await expect(orcaPage.locator('[data-native-chat-root="true"]')).toBeVisible({
        timeout: 15_000
      })
      await expect(orcaPage.getByText(LOADING_TITLE)).toBeVisible({ timeout: 10_000 })
      await expect(orcaPage.getByText(ERROR_TITLE)).toHaveCount(0)
      await orcaPage.screenshot({
        path: path.join(screenshotDir, '01-loading-no-error.png')
      })

      // Observe the uncached miss through IPC: a fixed 1500ms wait races UNFLUSHED_SETTLE_MS and retry cancellation.
      await expect
        .poll(
          () =>
            orcaPage.evaluate(
              ({ id, file }) =>
                window.api.nativeChat
                  .readSession('claude', id, 50, file)
                  .then((result) => Boolean(result && 'error' in result && result.notFound)),
              { id: sessionId, file: transcriptPath }
            ),
          { timeout: 10_000, message: 'transcript resolved before the first flush' }
        )
        .toBe(true)
      await expect(orcaPage.getByText(ERROR_TITLE)).toHaveCount(0)

      const userText = 'Explain the native chat first-flush race fix for #8401'
      const assistantText =
        'The main process now retries a not-yet-flushed transcript instead of caching a permanent miss.'
      writeFileSync(transcriptPath, claudeTranscriptLines({ sessionId, userText, assistantText }))

      // Scope to transcript content because user text also appears in workspace/tab chrome.
      const transcript = orcaPage.locator('[data-native-chat-root="true"]')
      await expect(transcript.getByText(userText)).toBeVisible({ timeout: 30_000 })
      await expect(transcript.getByText(assistantText)).toBeVisible({ timeout: 30_000 })
      await expect(orcaPage.getByText(ERROR_TITLE)).toHaveCount(0)
      await orcaPage.screenshot({
        path: path.join(screenshotDir, '02-hydrated.png')
      })
      const finalPane = await waitForPaneIdentitySnapshot(orcaPage, 1)
      expect(finalPane.tabId).toBe(boundPane.tabId)
      expect(finalPane.activeLeafId).toBe(boundPane.activeLeafId)
      expect(finalPane.ptyIdsByLeafId).toEqual(boundPane.ptyIdsByLeafId)
      await expect(transcript).toBeVisible()
    } finally {
      await testInfo.attach('transcript-pane-lifetime', {
        body: JSON.stringify(await finishLifetime()),
        contentType: 'application/json'
      })
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })
})
