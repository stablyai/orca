import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import type { GlobalSettings } from '../../src/shared/global-settings-types'

// The reply an agent is streaming answers the prompt the user just sent, so it has
// to render BELOW that prompt's optimistic bubble. Ranking every optimistic bubble
// last put the reply above the message that caused it: the sent prompt looked
// stuck at the bottom of the transcript and the reply had to be found by scrolling
// up. This asserts the rendered DOM order, which is the only place the tail
// ordering is actually observable.

const PRIOR_USER = 'Prior turn: summarize the release notes'
const PRIOR_REPLY = 'Prior turn reply: the notes are summarized.'
const OPTIMISTIC_PROMPT = 'Now run the integration tests'
const STREAMING_REPLY = 'Starting the integration tests for you right now.'

async function enableNativeChatSetting(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextSettings = await window.api.settings.set({ experimentalNativeChat: true })
    window.__store?.setState({ settings: nextSettings as GlobalSettings })
  })
}

// Seeds the store the same way a real Claude Code hook would: `working` plus a
// `lastAssistantMessage` preview is exactly the state that renders the streaming
// bubble before the turn reaches the transcript.
async function seedWorkingSessionWithPreview(
  page: Page,
  args: {
    paneKey: string
    worktreeId: string
    sessionId: string
    transcriptPath: string
    preview: string
  }
): Promise<void> {
  await page.evaluate(({ paneKey, worktreeId, sessionId, transcriptPath, preview }) => {
    window.__store?.getState().setAgentStatus(
      paneKey,
      {
        state: 'working',
        prompt: 'e2e streaming reply order probe',
        agentType: 'claude',
        lastAssistantMessage: preview
      },
      'Claude',
      undefined,
      { worktreeId },
      { providerSession: { key: 'session_id', id: sessionId, transcriptPath } }
    )
  }, args)
}

// An unsent-but-delivered launch prompt renders through the same optimistic-bubble
// tier as a composer send (`messageSortRank` treats both as the prompt the current
// turn is answering), so it reproduces the ordering without needing a live agent.
async function seedOptimisticPrompt(
  page: Page,
  args: { tabId: string; text: string }
): Promise<void> {
  await page.evaluate(({ tabId, text }) => {
    window.__store?.getState().seedNativeChatLaunchPrompt({
      tabId,
      agent: 'claude',
      text,
      createdAt: Date.now()
    })
  }, args)
}

async function toggleTerminalTabToChatView(
  page: Page,
  args: { tabId: string; worktreeId: string }
): Promise<void> {
  await page.evaluate(({ tabId, worktreeId }) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const unifiedTab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
      (tab) => tab.contentType === 'terminal' && tab.entityId === tabId
    )
    if (!unifiedTab) {
      throw new Error('Unified terminal tab not found for chat toggle')
    }
    state.toggleTabViewMode(unifiedTab.id)
  }, args)
}

function claudeTranscriptLines(sessionId: string): string {
  // Why these are in the past: `resolveLiveWorkingOverride` treats a trailing
  // assistant turn that post-dates the working epoch as the turn having already
  // completed, which suppresses the streaming preview. The realistic shape for
  // this bug is a prior turn that finished BEFORE the current one started.
  const userTime = new Date(Date.now() - 120_000)
  const assistantTime = new Date(userTime.getTime() + 2_000)
  const lines = [
    {
      sessionId,
      uuid: `${sessionId}-user`,
      timestamp: userTime.toISOString(),
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: PRIOR_USER }] }
    },
    {
      sessionId,
      uuid: `${sessionId}-assistant`,
      timestamp: assistantTime.toISOString(),
      type: 'assistant',
      message: { model: 'claude-opus-4', content: [{ type: 'text', text: PRIOR_REPLY }] }
    }
  ]
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
}

/** Trimmed text of each rendered row inside the chat transcript, in DOM order.
 *  Scoped to the message list on purpose: a page-wide text query also matches the
 *  sidebar's agent activity preview, which shows the same `lastAssistantMessage`
 *  and will happily satisfy an order assertion with no streaming bubble present. */
async function chatRowTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-native-chat-root="true"]')
    const scroller = root?.querySelector('.overflow-y-auto')
    const content = scroller?.firstElementChild
    return Array.from(content?.children ?? []).map((row) => (row.textContent ?? '').trim())
  })
}

test.describe('Native chat streaming reply order', () => {
  test('renders the streaming reply below the prompt it answers', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const [tabId] = descriptor.paneKey.split(':')
    const sessionId = `e2e-reply-order-${randomUUID()}`
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-reply-order-'))
    const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
    writeFileSync(transcriptPath, claudeTranscriptLines(sessionId))

    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `native-chat-streaming-reply-order-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })

    try {
      await enableNativeChatSetting(orcaPage)
      await seedWorkingSessionWithPreview(orcaPage, {
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId,
        sessionId,
        transcriptPath,
        preview: STREAMING_REPLY
      })
      await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })

      await expect(orcaPage.locator('[data-native-chat-root="true"]')).toBeVisible({
        timeout: 15_000
      })
      await expect(orcaPage.getByText(PRIOR_REPLY)).toBeVisible({ timeout: 30_000 })

      await seedOptimisticPrompt(orcaPage, { tabId, text: OPTIMISTIC_PROMPT })

      await expect(orcaPage.getByText(OPTIMISTIC_PROMPT)).toBeVisible({ timeout: 15_000 })
      await expect(orcaPage.getByText(STREAMING_REPLY).first()).toBeVisible({ timeout: 15_000 })

      // Screenshot BEFORE asserting so the captured frame shows whatever the build
      // actually rendered — including the wrong order on a pre-fix build.
      await orcaPage.screenshot({
        path: path.join(screenshotDir, 'streaming-reply-order.png')
      })

      const rows = await chatRowTexts(orcaPage)
      await testInfo.attach('chat-rows', {
        body: rows.map((row, i) => `${i}: ${row.slice(0, 90)}`).join('\n'),
        contentType: 'text/plain'
      })

      const promptRow = rows.findIndex((row) => row.includes(OPTIMISTIC_PROMPT))
      const replyRow = rows.findIndex((row) => row.includes(STREAMING_REPLY))

      expect(
        promptRow,
        'the sent prompt must render in the chat transcript'
      ).toBeGreaterThanOrEqual(0)
      expect(
        replyRow,
        'the streaming reply must render in the chat transcript (not just the sidebar preview)'
      ).toBeGreaterThanOrEqual(0)
      expect(promptRow, 'the streaming reply must render BELOW the prompt it answers').toBeLessThan(
        replyRow
      )
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })
})
