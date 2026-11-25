// Seeded Claude transcripts and session helpers shared by the history-prepend anchoring journeys.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Locator, Page } from '@stablyai/playwright-test'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady
} from '../../desktop/renderer-probes/store'
import { waitForActivePanePtyId, waitForPaneIdentitySnapshot } from '../../terminal/input/terminal'
import { waitForActivePaneHookDescriptor } from '../../terminal/input/terminal-active-pane'
import { waitForActiveTerminalManager } from '../../terminal/layout/terminal-pane-operations'
import { waitForPtyShellEcho } from '../../terminal/lifecycle/terminal-pty-readiness'

export const TRANSCRIPT_ROWS = 650
export const RUN_COMMANDS = 8

export type PrependTrace = {
  active: boolean
  /** Per painted frame: the content's offset, its row's offset, and the row chrome above the
   *  content (their difference), all from the viewport top. */
  frames: { content: number | null; slot: number | null; chrome?: number | null }[]
}

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Window augmentation requires declaration merging.
  interface Window {
    __nativeChatPrependTrace?: PrependTrace
  }
}

export async function enableNativeChatSetting(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextSettings = await window.api.settings.set({
      nativeChatProviders: { claude: true, codex: true },
      nativeChatAppearance: { fontSize: 13, matchTerminalInterface: false }
    })
    window.__store?.setState({ settings: nextSettings })
  })
}

export async function seedClaudeProviderSession(
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

export async function toggleTerminalTabToChatView(
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

export async function activateNewTerminalTab(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const tab = state.createTab(id, undefined, undefined, { activate: true })
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal', store.getState().activeWorktreeId)
  }, worktreeId)
}

export async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    state.setActiveTab(id)
    state.setActiveTabType('terminal', store.getState().activeWorktreeId)
  }, tabId)
}

export async function publishHiddenLaunchMessage(
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

export async function settleScroll(scroll: Locator): Promise<void> {
  await scroll.evaluate(async (element) => {
    let previousGeometry = ''
    let stableFrames = 0
    for (let frame = 0; frame < 180 && stableFrames < 3; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const geometry = `${element.scrollHeight}:${element.scrollTop}`
      stableFrames = geometry === previousGeometry ? stableFrames + 1 : 0
      previousGeometry = geometry
    }
  })
}

export async function nextFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (frames) => {
    for (let frame = 0; frame < frames; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  }, count)
}

/** A prompt, a long stretch of its answer, then a run of commands the first window cuts in two;
 *  the first older page extends the run without reaching the prompt, so the turn stays unfolded. */
/** `answerRows`: answer rows between the prompt and the run; 0 makes the first older page bring
 *  the run's prompt, and with it the turn's settled status. */
export function claudeRunTranscript(sessionId: string, { answerRows = 260 } = {}): string {
  const startedAt = Date.now() - 1_000_000
  let at = 0
  const line = (type: 'user' | 'assistant', content: unknown[]) => {
    at += 1
    return JSON.stringify({
      sessionId,
      uuid: `${sessionId}-${at}`,
      timestamp: new Date(startedAt + at * 1_000).toISOString(),
      type,
      // Records sharing a message id are one message; each record here is its own.
      message: { id: `message-${at}`, role: type, model: 'claude-opus-4', content }
    })
  }
  const text = (type: 'user' | 'assistant', index: number) =>
    line(type, [{ type: 'text', text: `E2E run transcript row ${String(index).padStart(4, '0')}` }])
  const answer = Array.from({ length: answerRows }, (_, index) => text('assistant', index))
  const run = Array.from({ length: RUN_COMMANDS }, (_, index) => [
    line('assistant', [
      {
        type: 'tool_use',
        id: `run-${index}`,
        name: 'Bash',
        input: { command: `cat run-${index}.log` }
      }
    ]),
    line('user', [{ type: 'tool_result', tool_use_id: `run-${index}`, content: `run ${index} ok` }])
  ]).flat()
  const newer = Array.from({ length: 296 }, (_, index) =>
    text(index % 2 === 0 ? 'assistant' : 'user', index + 1_000)
  )
  const prompt = line('user', [{ type: 'text', text: 'E2E run prompt' }])
  return `${[prompt, ...answer, ...run, ...newer].join('\n')}\n`
}

export function claudeTranscript(rowCount: number, sessionId: string, tools = false): string {
  const startedAt = Date.now() - rowCount * 1_000
  return `${Array.from({ length: rowCount }, (_, index) => {
    const marker = `E2E transcript row ${String(index).padStart(4, '0')}`
    const body = Array.from(
      { length: tools ? 1 + (index % 7) : 5 },
      (_unused, line) => `Measured paragraph ${line + 1} for row ${String(index).padStart(4, '0')}.`
    ).join('\n\n')
    const row = JSON.stringify({
      sessionId,
      uuid: `${sessionId}-${index}`,
      timestamp: new Date(startedAt + index * 1_000).toISOString(),
      type: index % 2 === 0 ? 'user' : 'assistant',
      message: {
        role: index % 2 === 0 ? 'user' : 'assistant',
        model: 'claude-opus-4',
        content: [
          { type: 'text', text: `${marker}\n\n${body}` },
          ...(tools && index % 2 !== 0
            ? [
                {
                  type: 'tool_use',
                  id: `call-${index}`,
                  name: 'Bash',
                  input: { command: `cat row-${index}.log` }
                }
              ]
            : [])
        ]
      }
    })
    return tools && index % 2 !== 0
      ? `${row}\n${JSON.stringify({
          sessionId,
          uuid: `${sessionId}-${index}-result`,
          timestamp: new Date(startedAt + index * 1_000).toISOString(),
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: `call-${index}`,
                content: 'Output line\n'.repeat(1_500)
              }
            ]
          }
        })}`
      : row
  }).join('\n')}\n`
}

/**
 * Seeds a Claude transcript into the active terminal pane and opens it as a chat. With
 * `manualPaging`, older pages land only through the Load earlier button.
 */
export async function openSeededTerminalChat(
  page: Page,
  transcript: (sessionId: string) => string,
  { manualPaging = false }: { manualPaging?: boolean } = {}
): Promise<{
  scroll: Locator
  tabId: string
  worktreeId: string
  transcriptPath: string
  cleanup: () => void
}> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneIdentitySnapshot(page, 1)
  await waitForPtyShellEcho(page, await waitForActivePanePtyId(page), 15_000)
  const descriptor = await waitForActivePaneHookDescriptor(page)
  const [tabId] = descriptor.paneKey.split(':')
  const sessionId = `e2e-history-${randomUUID()}`
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-native-chat-history-'))
  const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
  writeFileSync(transcriptPath, transcript(sessionId))
  await enableNativeChatSetting(page)
  await seedClaudeProviderSession(page, {
    paneKey: descriptor.paneKey,
    worktreeId: descriptor.worktreeId,
    sessionId,
    transcriptPath
  })
  if (manualPaging) {
    await page.evaluate(() => {
      Object.assign(window, { __e2eIntersectionObserver: window.IntersectionObserver })
      Object.defineProperty(window, 'IntersectionObserver', {
        value: undefined,
        configurable: true
      })
    })
  }
  await toggleTerminalTabToChatView(page, { tabId: tabId!, worktreeId: descriptor.worktreeId })
  return {
    scroll: page.locator('[data-native-chat-scroll]'),
    tabId: tabId!,
    worktreeId: descriptor.worktreeId,
    transcriptPath,
    cleanup: () => rmSync(scratchDir, { recursive: true, force: true })
  }
}

/** Gives back the observer `manualPaging` took away, which other panes (terminals) need. */
export async function restoreIntersectionObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const saved = (window as unknown as { __e2eIntersectionObserver?: unknown })
      .__e2eIntersectionObserver
    if (saved) {
      Object.defineProperty(window, 'IntersectionObserver', { value: saved, configurable: true })
    }
  })
}
