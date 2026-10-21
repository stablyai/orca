// Exercise the rail's per-tick preview and its jumps against a real transcript.

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'

/** 30 user turns, so the rail is well past its 20-tick sampling cap. */
const TRANSCRIPT_ROWS = 60
const SHOT_DIR = path.join(os.tmpdir(), 'orca-rail-validation-larvacean', 'shots')

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
        { state: 'working', prompt: 'e2e message rail probe', agentType: 'claude' },
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

function claudeTranscript(rowCount: number, sessionId: string): string {
  const startedAt = Date.now() - rowCount * 1_000
  return `${Array.from({ length: rowCount }, (_, index) => {
    const isUser = index % 2 === 0
    const turn = Math.floor(index / 2)
    const body = isUser
      ? `Question ${turn}: what does the rail do when I scroll a long reply?`
      : [
          // Headings and code draw at heights the row estimate misses, so a jump
          // crosses rows that resize under it.
          `## Answer for turn ${turn}`,
          `\`\`\`ts\n${Array.from({ length: 2 + (turn % 5) * 4 }, (_unused, line) => `const line${line} = ${turn}`).join('\n')}\n\`\`\``,
          ...Array.from(
            { length: 6 + (turn % 7) * 3 },
            (_unused, line) => `Answer paragraph ${line + 1} for turn ${turn}.`
          )
        ].join('\n\n')
    return JSON.stringify({
      sessionId,
      uuid: `${sessionId}-${index}`,
      timestamp: new Date(startedAt + index * 1_000).toISOString(),
      type: isUser ? 'user' : 'assistant',
      message: {
        role: isUser ? 'user' : 'assistant',
        model: 'claude-opus-4',
        content: [{ type: 'text', text: body }]
      }
    })
  }).join('\n')}\n`
}

test.describe('Native chat message rail', () => {
  test('previews prompts and jumps without following later output', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const [tabId] = descriptor.paneKey.split(':')
    const sessionId = `e2e-message-rail-${randomUUID()}`
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-native-chat-rail-'))
    const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
    writeFileSync(transcriptPath, claudeTranscript(TRANSCRIPT_ROWS, sessionId))
    mkdirSync(SHOT_DIR, { recursive: true })

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
    const transcriptWindow = orcaPage.locator('[data-native-chat-window]')
    await expect(transcriptWindow).toBeVisible({ timeout: 30_000 })

    const rail = orcaPage.locator('[data-native-chat-rail]')
    await expect(rail).toBeVisible({ timeout: 30_000 })

    // Every user turn has a tick while the rail fits: a tick is the only way to its message.
    const ticks = rail.getByRole('button')
    await expect(ticks).toHaveCount(TRANSCRIPT_ROWS / 2)

    await orcaPage.screenshot({
      path: path.join(SHOT_DIR, 'rail-01-app.png'),
      animations: 'disabled'
    })

    // Hovering one tick previews that message and the reply to it, not the whole thread.
    const tick = rail.getByRole('button', { name: 'Question 5:', exact: false })
    await tick.hover()
    const preview = orcaPage.locator('[data-slot="hover-card-content"]')
    await expect(preview).toBeVisible({ timeout: 10_000 })
    await expect(preview).toContainText('Question 5:')
    await expect(preview).not.toContainText('Question 6:')
    await expect(preview).toContainText('Answer for turn 5')
    await expect(preview.locator('p')).toHaveCount(2)
    await orcaPage.screenshot({
      path: path.join(SHOT_DIR, 'rail-02-preview.png'),
      animations: 'disabled'
    })

    const scroller = orcaPage.locator('[data-native-chat-scroll]')
    const offsetOf = (row: Locator) => async (): Promise<number> => {
      const [box, viewport] = await Promise.all([row.boundingBox(), scroller.boundingBox()])
      return box && viewport ? Math.abs(box.y - viewport.y) : Number.POSITIVE_INFINITY
    }
    // One click lands the message at the top and lights its tick: from the end to a
    // message near it, then across the thread, with rows resizing under each jump.
    // Animated and instant jumps take different paths through the list.
    for (const reducedMotion of ['reduce', 'no-preference'] as const) {
      await orcaPage.emulateMedia({ reducedMotion })
      for (const turn of [22, 12, 5]) {
        const jumped = rail.getByRole('button', { name: `Question ${turn}:`, exact: false })
        await jumped.click()
        await expect
          .poll(offsetOf(transcriptWindow.locator(`[data-index="${turn * 2}"]`)))
          .toBeLessThan(4)
        await expect(jumped).toHaveAttribute('aria-current', 'true')
      }
    }
    const targetOffset = offsetOf(transcriptWindow.locator('[data-index="10"]'))

    for (let revision = 0; revision < 3; revision += 1) {
      const body = `Later streamed output ${revision}`
      appendFileSync(
        transcriptPath,
        `${JSON.stringify({
          sessionId,
          uuid: `${sessionId}-stream-${revision}`,
          type: 'assistant',
          timestamp: new Date().toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: body }] }
        })}\n`
      )
      await expect(transcriptWindow.getByText(body, { exact: true })).toBeAttached()
      await expect.poll(targetOffset).toBeLessThan(4)
    }

    console.log(`[rail] shots=${SHOT_DIR}`)
  })
})
