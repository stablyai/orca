import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'

const LONG_PROMPT_LINES = 80

async function enableNativeChatSetting(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextSettings = await window.api.settings.set({ experimentalNativeChat: true })
    window.__store?.setState({ settings: nextSettings })
  })
}

async function seedClaudeProviderSession(
  page: Page,
  args: { paneKey: string; worktreeId: string; sessionId: string; transcriptPath: string }
): Promise<void> {
  await page.evaluate(({ paneKey, worktreeId, sessionId, transcriptPath }) => {
    window.__store
      ?.getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'e2e long prompt probe', agentType: 'claude' },
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

function longPrompt(name: string): string {
  const lines = Array.from(
    { length: LONG_PROMPT_LINES },
    (_unused, line) => `${name} line ${line + 1} of a long prompt.`
  )
  return [...lines, `[${name} link](https://example.com)`].join('\n\n')
}

function transcriptLine(
  sessionId: string,
  id: string,
  role: string,
  text: string,
  timestamp = Date.now()
): string {
  return `${JSON.stringify({
    sessionId,
    uuid: `${sessionId}-${id}`,
    type: role,
    timestamp: new Date(timestamp).toISOString(),
    message: { role, model: 'claude-opus-4', content: [{ type: 'text', text }] }
  })}\n`
}

/** Opens a native chat on a transcript of alternating user and assistant turns. */
async function openChat(page: Page, turns: readonly string[]): Promise<void> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)

  const descriptor = await waitForActivePaneHookDescriptor(page)
  const [tabId] = descriptor.paneKey.split(':')
  const sessionId = `e2e-long-prompt-${randomUUID()}`
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-native-chat-long-prompt-'))
  const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
  // Distinct, increasing times: the transcript orders its rows by them.
  const startedAt = Date.now() - turns.length * 1_000
  writeFileSync(
    transcriptPath,
    turns
      .map((text, index) =>
        transcriptLine(
          sessionId,
          String(index),
          index % 2 === 0 ? 'user' : 'assistant',
          text,
          startedAt + index * 1_000
        )
      )
      .join('')
  )

  await enableNativeChatSetting(page)
  await seedClaudeProviderSession(page, {
    paneKey: descriptor.paneKey,
    worktreeId: descriptor.worktreeId,
    sessionId,
    transcriptPath
  })
  await toggleTerminalTabToChatView(page, { tabId, worktreeId: descriptor.worktreeId })
  await expect(page.locator('[data-native-chat-window]')).toBeVisible({ timeout: 30_000 })
}

// Retried: a windowed row can be replaced between resolving it and scrolling to it.
async function scrollTo(target: Locator): Promise<void> {
  await expect(async () => {
    await target.scrollIntoViewIfNeeded({ timeout: 2_000 })
  }).toPass()
}

test.describe('Native chat long user message', () => {
  test('folds a long prompt and opens it on request', async ({ orcaPage }) => {
    const reply = Array.from(
      { length: 12 },
      (_unused, line) => `Answer paragraph ${line + 1}.`
    ).join('\n\n')
    // Enough after the long prompt that refolding it cannot be rescued by the scroll clamp.
    const middle = Array.from({ length: 6 }, () => ['Another short prompt.', reply]).flat()
    await openChat(orcaPage, ['A short prompt.', reply, longPrompt('Early'), reply, ...middle])
    const transcriptWindow = orcaPage.locator('[data-native-chat-window]')
    const scroller = orcaPage.locator('[data-native-chat-scroll]')
    const promptRow = (name: string) => {
      const row = transcriptWindow
        .locator('[data-index]')
        .filter({ hasText: `${name} line 1 of a long prompt.` })
      return {
        line: (line: number) => row.getByText(`${name} line ${line} of`, { exact: false }),
        folded: row.locator('[data-native-chat-user-message-folded]'),
        showFull: row.getByRole('button', { name: 'Show full message' }),
        showLess: row.getByRole('button', { name: 'Show less' }),
        link: row.getByRole('link', { name: `${name} link` })
      }
    }

    // The transcript opens following its end, and only a reader's own scrolling leaves it.
    const early = promptRow('Early')
    await scroller.hover()
    await expect(async () => {
      await orcaPage.mouse.wheel(0, -4_000)
      await expect(early.line(1)).toBeAttached({ timeout: 500 })
    }).toPass()
    await scrollTo(early.line(1))
    await expect(transcriptWindow.getByRole('button', { name: 'Show full message' })).toHaveCount(1)
    await expect(early.folded).toHaveCount(1)
    expect((await early.folded.boundingBox())?.height).toBeCloseTo(176, 0)
    await expect(early.line(LONG_PROMPT_LINES)).not.toBeInViewport()

    await early.showFull.click()
    await expect(early.folded).toHaveCount(0)
    await scrollTo(early.showLess)
    await expect(early.line(LONG_PROMPT_LINES)).toBeInViewport()

    await early.showLess.click()
    await expect(early.folded).toHaveCount(1)
    await expect(early.showFull).toBeInViewport()
    await expect(early.line(1)).toBeInViewport()

    // A keyboard user reaching a link under the fold sees it, and gets the top back afterwards.
    await early.link.focus()
    await expect(early.link).toBeInViewport()
    await expect(early.folded).toHaveCount(1)
    await early.showFull.focus()
    await expect(early.line(1)).toBeInViewport()
  })

  test('leaves a prompt alone when its long text already fits the preview', async ({
    orcaPage
  }) => {
    // Nine source lines, so the text rule picks it, yet it renders shorter than the clip.
    await openChat(orcaPage, [['One.', 'Two.', 'Three.', 'Four.', 'Five.'].join('\n\n'), 'Done.'])
    const transcriptWindow = orcaPage.locator('[data-native-chat-window]')
    await expect(transcriptWindow.getByText('Five.')).toBeVisible()
    await expect(transcriptWindow.getByRole('button', { name: 'Show full message' })).toHaveCount(0)
    await expect(transcriptWindow.locator('[data-native-chat-user-message-folded]')).toHaveCount(0)
  })
})
