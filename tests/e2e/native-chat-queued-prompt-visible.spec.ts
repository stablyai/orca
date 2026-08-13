import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import type { GlobalSettings } from '../../src/shared/types'

const FIRST_PROMPT = 'start the long running task'
const QUEUED_PROMPT = 'and check the config while you are at it'
const FIRST_REPLY = 'working through the first task now'
const REPLY = 'both done'

async function enableNativeChatSetting(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextSettings = await window.api.settings.set({ experimentalNativeChat: true })
    window.__store?.setState({ settings: nextSettings as GlobalSettings })
  })
}

// Mirrors native-chat-first-flush-race.spec.ts: drive the same store → NativeChatView
// path a real Claude Code hook would, without an installed CLI.
async function seedClaudeProviderSession(
  page: Page,
  args: { paneKey: string; worktreeId: string; sessionId: string; transcriptPath: string }
): Promise<void> {
  await page.evaluate(({ paneKey, worktreeId, sessionId, transcriptPath }) => {
    window.__store
      ?.getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'e2e queued prompt probe', agentType: 'claude' },
        'Claude',
        undefined,
        { worktreeId },
        { providerSession: { key: 'session_id', id: sessionId, transcriptPath } }
      )
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

/** A session where the second prompt arrived mid-turn and Claude queued it. */
function transcriptWithQueuedPrompt(sessionId: string): string {
  const base = Date.now()
  const at = (offsetMs: number): string => new Date(base + offsetMs).toISOString()
  const lines = [
    {
      sessionId,
      uuid: `${sessionId}-user`,
      timestamp: at(0),
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: FIRST_PROMPT }] }
    },
    { type: 'queue-operation', operation: 'enqueue', timestamp: at(2_000), content: QUEUED_PROMPT },
    // Why: the queue drains later, so the reply to the FIRST prompt lands before
    // the queued one is taken — keep that gap rather than a 0-gap ideal.
    {
      sessionId,
      uuid: `${sessionId}-work`,
      parentUuid: `${sessionId}-user`,
      timestamp: at(3_000),
      type: 'assistant',
      message: { model: 'claude-opus-4', content: [{ type: 'text', text: FIRST_REPLY }] }
    },
    { type: 'queue-operation', operation: 'remove', timestamp: at(4_000), content: QUEUED_PROMPT },
    // Why: a prompt sent while the agent is busy is almost always recorded only
    // like this — no `user` record is written for it — and Claude appends it once
    // the queue drains, so it lands here while still stamped at enqueue time.
    {
      sessionId,
      uuid: `${sessionId}-queued`,
      parentUuid: `${sessionId}-work`,
      timestamp: at(2_000),
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt: QUEUED_PROMPT,
        commandMode: 'prompt',
        origin: { kind: 'human' },
        timestamp: at(2_000)
      }
    },
    {
      sessionId,
      uuid: `${sessionId}-assistant`,
      parentUuid: `${sessionId}-work`,
      timestamp: at(6_000),
      type: 'assistant',
      message: { model: 'claude-opus-4', content: [{ type: 'text', text: REPLY }] }
    }
  ]
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
}

test.describe('Native chat shows prompts the agent queued mid-turn', () => {
  test('renders a queued prompt where the agent took it, matching the terminal', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const [tabId] = descriptor.paneKey.split(':')
    const sessionId = `e2e-queued-prompt-${randomUUID()}`
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-queued-prompt-'))
    const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)

    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `native-chat-queued-prompt-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })

    try {
      writeFileSync(transcriptPath, transcriptWithQueuedPrompt(sessionId))

      await enableNativeChatSetting(orcaPage)
      await seedClaudeProviderSession(orcaPage, {
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId,
        sessionId,
        transcriptPath
      })
      await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })

      const chat = orcaPage.locator('[data-native-chat-root="true"]')
      await expect(chat).toBeVisible({ timeout: 15_000 })
      await expect(chat.getByText(FIRST_PROMPT)).toBeVisible({ timeout: 30_000 })
      await expect(chat.getByText(REPLY)).toBeVisible({ timeout: 30_000 })

      // The queued prompt is the one that used to vanish from chat entirely.
      // Count first: a strict-mode locator assertion would fail confusingly on a
      // double render instead of reporting the count.
      await expect(chat.getByText(QUEUED_PROMPT)).toHaveCount(1, { timeout: 30_000 })
      await expect(chat.getByText(QUEUED_PROMPT)).toBeVisible()
      await orcaPage.screenshot({ path: path.join(screenshotDir, '01-queued-prompt-visible.png') })

      const order = await chat.evaluate(
        (root, texts) => {
          const body = root.textContent ?? ''
          return texts.map((text) => body.indexOf(text))
        },
        [FIRST_PROMPT, FIRST_REPLY, QUEUED_PROMPT, REPLY]
      )

      expect(order).not.toContain(-1)
      // Why: the queued prompt sits after the reply that preceded it in the file,
      // so chat reads in the same order the terminal showed.
      expect(order).toEqual([...order].sort((left, right) => left - right))
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })
})
