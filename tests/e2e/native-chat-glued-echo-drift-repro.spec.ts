import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  getTerminalContent,
  waitForActivePaneHookDescriptor,
  waitForActiveTerminalManager
} from './helpers/terminal'
import type { GlobalSettings } from '../../src/shared/types'

const FIRST_SEND = 'tell me a joke'
const SECOND_SEND = 'continue'
const SEED_ASSISTANT = 'seed turn so the transcript hydrates'
const NEWEST_ASSISTANT = 'newest real turn from the agent'

async function enableNativeChatSetting(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextSettings = await window.api.settings.set({ experimentalNativeChat: true })
    window.__store?.setState({ settings: nextSettings as GlobalSettings })
  })
}

// Why: mirrors native-chat-first-flush-race.spec.ts — drives the identical
// store → NativeChatView path a real Claude Code hook would, with no CLI.
// `idle` (not `working`) keeps the composer action a Send button.
async function seedClaudeProviderSession(
  page: Page,
  args: { paneKey: string; worktreeId: string; sessionId: string; transcriptPath: string }
): Promise<void> {
  await page.evaluate(({ paneKey, worktreeId, sessionId, transcriptPath }) => {
    window.__store
      ?.getState()
      .setAgentStatus(
        paneKey,
        { state: 'idle', prompt: 'e2e glued echo drift probe', agentType: 'claude' },
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

function transcriptLines(
  sessionId: string,
  turns: readonly { role: 'user' | 'assistant'; text: string }[]
): string {
  const base = Date.now()
  return `${turns
    .map((turn, index) =>
      JSON.stringify({
        sessionId,
        uuid: `${sessionId}-${index}`,
        timestamp: new Date(base + index * 1_000).toISOString(),
        type: turn.role,
        message:
          turn.role === 'user'
            ? { role: 'user', content: [{ type: 'text', text: turn.text }] }
            : { model: 'claude-opus-4', content: [{ type: 'text', text: turn.text }] }
      })
    )
    .join('\n')}\n`
}

test.describe('Native chat glued optimistic echoes never retire', () => {
  test('two rapid sends glued into one transcript row retire their echoes', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const [tabId] = descriptor.paneKey.split(':')
    const sessionId = `e2e-glued-echo-${randomUUID()}`
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-glued-echo-'))
    const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)

    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `native-chat-glued-echo-drift-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })

    try {
      writeFileSync(
        transcriptPath,
        transcriptLines(sessionId, [{ role: 'assistant', text: SEED_ASSISTANT }])
      )

      await enableNativeChatSetting(orcaPage)
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
      await expect(orcaPage.getByText(SEED_ASSISTANT)).toBeVisible({ timeout: 30_000 })

      // Why: Enter is a separate delayed pty write, so a second send issued
      // inside that window writes its body onto the same unsubmitted input line.
      const composer = orcaPage.getByPlaceholder('Send a message…')
      await composer.fill(FIRST_SEND)
      await composer.press('Enter')
      await composer.fill(SECOND_SEND)
      await composer.press('Enter')

      await expect(orcaPage.getByText(FIRST_SEND, { exact: true })).toBeVisible({ timeout: 10_000 })
      await orcaPage.screenshot({ path: path.join(screenshotDir, '01-two-optimistic-echoes.png') })

      // Evidence: what the two bodies actually look like on the pty input line.
      const terminalText = await getTerminalContent(orcaPage)
      await testInfo.attach('pty-input-line', {
        body: terminalText,
        contentType: 'text/plain'
      })

      // The agent accepts both bodies as one prompt, separated as the pty saw it.
      writeFileSync(
        transcriptPath,
        transcriptLines(sessionId, [
          { role: 'assistant', text: SEED_ASSISTANT },
          { role: 'user', text: `${FIRST_SEND} ${SECOND_SEND}` },
          { role: 'assistant', text: NEWEST_ASSISTANT }
        ])
      )

      await expect(orcaPage.getByText(NEWEST_ASSISTANT)).toBeVisible({ timeout: 30_000 })
      await orcaPage.screenshot({ path: path.join(screenshotDir, '02-after-glued-turn.png') })

      // Both optimistic echoes are represented by the glued row and must go.
      await expect(orcaPage.getByText(FIRST_SEND, { exact: true })).toHaveCount(0)
      await expect(orcaPage.getByText(SECOND_SEND, { exact: true })).toHaveCount(0)
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })
})
