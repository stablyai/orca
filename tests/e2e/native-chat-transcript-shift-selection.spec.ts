import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import type { GlobalSettings } from '../../src/shared/global-settings-types'

const FIRST = 'Alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha.'
const MIDDLE = 'Bravo bravo bravo bravo bravo bravo bravo bravo bravo bravo bravo.'
const LAST = 'Charlie charlie charlie charlie charlie charlie charlie charlie.'

async function enableNativeChatSetting(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextSettings = await window.api.settings.set({ experimentalNativeChat: true })
    window.__store?.setState({ settings: nextSettings as GlobalSettings })
  })
}

async function seedIdleStatus(
  page: Page,
  args: { paneKey: string; worktreeId: string; sessionId: string; transcriptPath: string }
): Promise<void> {
  await page.evaluate(({ paneKey, worktreeId, sessionId, transcriptPath }) => {
    window.__store
      ?.getState()
      .setAgentStatus(
        paneKey,
        { state: 'idle', prompt: 'shift selection repro', agentType: 'claude' },
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

function transcript(sessionId: string): string {
  const base = new Date()
  const lines = [
    {
      sessionId,
      uuid: `${sessionId}-user`,
      timestamp: base.toISOString(),
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Say three things' }] }
    },
    ...[FIRST, MIDDLE, LAST].map((text, index) => ({
      sessionId,
      uuid: `${sessionId}-assistant-${index}`,
      timestamp: new Date(base.getTime() + (index + 1) * 2_000).toISOString(),
      type: 'assistant',
      message: { model: 'claude-opus-4', content: [{ type: 'text', text }] }
    }))
  ]
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
}

test.describe('Native chat shift-click selection extension', () => {
  test('shift+click extends an existing transcript selection', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const [tabId] = descriptor.paneKey.split(':')
    const sessionId = `e2e-shift-selection-${randomUUID()}`
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-shift-selection-'))
    const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)

    try {
      writeFileSync(transcriptPath, transcript(sessionId))
      await enableNativeChatSetting(orcaPage)
      await seedIdleStatus(orcaPage, {
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId,
        sessionId,
        transcriptPath
      })
      await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })

      await expect(orcaPage.locator('[data-native-chat-root="true"]')).toBeVisible({
        timeout: 15_000
      })
      const first = orcaPage.getByText(FIRST)
      const last = orcaPage.getByText(LAST)
      await expect(first).toBeVisible({ timeout: 30_000 })
      await expect(last).toBeVisible({ timeout: 30_000 })

      const firstBox = await first.boundingBox()
      const lastBox = await last.boundingBox()
      if (!firstBox || !lastBox) {
        throw new Error('Transcript rows have no layout box')
      }

      // 1. Drag-select part of the first assistant turn.
      await orcaPage.mouse.move(firstBox.x + 4, firstBox.y + firstBox.height / 2)
      await orcaPage.mouse.down()
      await orcaPage.mouse.move(firstBox.x + 120, firstBox.y + firstBox.height / 2, { steps: 10 })
      await orcaPage.mouse.up()
      const afterDrag = await orcaPage.evaluate(() => window.getSelection()?.toString() ?? '')
      const activeAfterDrag = await orcaPage.evaluate(
        () => document.activeElement?.tagName ?? 'none'
      )

      // 2. Shift+click below it — the selection should grow to cover the middle turn.
      await orcaPage.keyboard.down('Shift')
      await orcaPage.mouse.move(lastBox.x + 120, lastBox.y + lastBox.height / 2)
      await orcaPage.mouse.down()
      await orcaPage.mouse.up()
      await orcaPage.keyboard.up('Shift')
      const afterShift = await orcaPage.evaluate(() => window.getSelection()?.toString() ?? '')
      const activeAfterShift = await orcaPage.evaluate(
        () => document.activeElement?.tagName ?? 'none'
      )

      console.log(
        JSON.stringify({ afterDrag, activeAfterDrag, afterShift, activeAfterShift }, null, 2)
      )

      expect(afterDrag.length).toBeGreaterThan(0)
      expect(afterShift).toContain('Bravo')
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })
})
