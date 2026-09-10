import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import type { GlobalSettings } from '../../src/shared/global-settings-types'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'

const TRANSCRIPT_ROWS = 650

async function enableNativeChatSetting(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextSettings = await window.api.settings.set({ experimentalNativeChat: true })
    window.__store?.setState({ settings: nextSettings as GlobalSettings })
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
        { state: 'working', prompt: 'e2e history anchor probe', agentType: 'claude' },
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
    const marker = `E2E transcript row ${String(index).padStart(4, '0')}`
    const body = Array.from(
      { length: 5 },
      (_unused, line) => `Measured paragraph ${line + 1} for row ${String(index).padStart(4, '0')}.`
    ).join('\n\n')
    return JSON.stringify({
      sessionId,
      uuid: `${sessionId}-${index}`,
      timestamp: new Date(startedAt + index * 1_000).toISOString(),
      type: index % 2 === 0 ? 'user' : 'assistant',
      message: {
        role: index % 2 === 0 ? 'user' : 'assistant',
        model: 'claude-opus-4',
        content: [{ type: 'text', text: `${marker}\n\n${body}` }]
      }
    })
  }).join('\n')}\n`
}

test.describe('Native chat history prepend anchoring', () => {
  test('keeps the visible transcript row at the same viewport offset', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const [tabId] = descriptor.paneKey.split(':')
    const sessionId = `e2e-prepend-anchor-${randomUUID()}`
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-native-chat-anchor-'))
    const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
    writeFileSync(transcriptPath, claudeTranscript(TRANSCRIPT_ROWS, sessionId))

    try {
      await enableNativeChatSetting(orcaPage)
      await seedClaudeProviderSession(orcaPage, {
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId,
        sessionId,
        transcriptPath
      })
      await toggleTerminalTabToChatView(orcaPage, {
        tabId,
        worktreeId: descriptor.worktreeId
      })

      await expect(orcaPage.locator('[data-native-chat-root="true"]')).toBeVisible({
        timeout: 15_000
      })
      const scroll = orcaPage.locator('[data-native-chat-scroll]')
      const transcriptWindow = orcaPage.locator('[data-native-chat-window]')
      const loadEarlier = orcaPage.getByRole('button', { name: 'Load earlier messages' })
      await expect(transcriptWindow).toBeVisible({ timeout: 30_000 })
      await expect(loadEarlier).toBeAttached({ timeout: 30_000 })
      await expect
        .poll(() => transcriptWindow.locator(':scope > [data-index]').count())
        .toBeGreaterThan(3)

      const initialTotalSize = await transcriptWindow.evaluate((element) => element.offsetHeight)
      const anchor = await scroll.evaluate(async (element) => {
        element.scrollTop = element.scrollHeight * 0.55
        element.dispatchEvent(new Event('scroll', { bubbles: true }))
        let previousGeometry = ''
        let stableFrames = 0
        for (let frame = 0; frame < 120 && stableFrames < 5; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          const geometry = `${element.scrollHeight}:${element.scrollTop}`
          stableFrames = geometry === previousGeometry ? stableFrames + 1 : 0
          previousGeometry = geometry
        }
        const scrollRect = element.getBoundingClientRect()
        const candidates = Array.from(
          element.querySelectorAll<HTMLElement>('[data-native-chat-window] > [data-index]')
        ).filter((row) => {
          const rect = row.getBoundingClientRect()
          return rect.top >= scrollRect.top + 40 && rect.bottom <= scrollRect.bottom - 40
        })
        const row = candidates[Math.floor(candidates.length / 2)]
        const marker = row
          ? Array.from(row.querySelectorAll('p')).find((paragraph) =>
              /^E2E transcript row \d{4}$/.test(paragraph.textContent?.trim() ?? '')
            )
          : undefined
        if (!row || !marker) {
          return null
        }
        return {
          index: Number(row.dataset.index),
          marker: marker.textContent?.trim() ?? '',
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
          viewportOffset: row.getBoundingClientRect().top - scrollRect.top
        }
      })
      expect(anchor, 'expected a fully visible measured row to anchor').not.toBeNull()
      if (!anchor) {
        throw new Error('Expected a fully visible measured row to anchor')
      }

      // The button stays off-screen so invoking it here exercises the real pagination
      // handler without Playwright first scrolling the reader to the transcript head.
      await loadEarlier.evaluate((button: HTMLButtonElement) => button.click())
      await expect
        .poll(() => transcriptWindow.evaluate((element) => element.offsetHeight))
        .toBeGreaterThan(initialTotalSize)
      await expect(loadEarlier).toBeAttached({ timeout: 30_000 })

      const anchoredMarker = orcaPage.getByText(anchor.marker, { exact: true })
      await expect(anchoredMarker).toBeAttached({ timeout: 15_000 })
      const after = await anchoredMarker.evaluate(async (marker) => {
        const row = marker.closest<HTMLElement>('[data-index]')
        const scrollRoot = marker.closest<HTMLElement>('[data-native-chat-scroll]')
        if (!row || !scrollRoot) {
          return null
        }
        let previousGeometry = ''
        let stableFrames = 0
        for (let frame = 0; frame < 120 && stableFrames < 5; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          const geometry = `${scrollRoot.scrollHeight}:${scrollRoot.scrollTop}`
          stableFrames = geometry === previousGeometry ? stableFrames + 1 : 0
          previousGeometry = geometry
        }
        return {
          index: Number(row.dataset.index),
          scrollHeight: scrollRoot.scrollHeight,
          scrollTop: scrollRoot.scrollTop,
          viewportOffset: row.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top
        }
      })
      expect(after, 'anchored row must remain mounted after history prepends').not.toBeNull()
      expect(after?.index).toBe(anchor.index + 200)
      const contentGrowth = (after?.scrollHeight ?? 0) - anchor.scrollHeight
      const scrollAdjustment = (after?.scrollTop ?? 0) - anchor.scrollTop
      expect(
        Math.abs(contentGrowth - scrollAdjustment),
        `content grew ${contentGrowth}px while scrollTop adjusted ${scrollAdjustment}px`
      ).toBeLessThanOrEqual(2)
      expect(Math.abs((after?.viewportOffset ?? 0) - anchor.viewportOffset)).toBeLessThanOrEqual(3)
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })
})
