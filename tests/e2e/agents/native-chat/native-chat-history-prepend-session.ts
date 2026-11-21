// Seeded Claude transcripts and session helpers shared by the history-prepend anchoring journeys.
import type { Locator, Page } from '@stablyai/playwright-test'

export const TRANSCRIPT_ROWS = 650
export const RUN_COMMANDS = 8

export type PrependTrace = {
  active: boolean
  frames: { content: number | null; slot: number | null }[]
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
export function claudeRunTranscript(sessionId: string): string {
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
  const answer = Array.from({ length: 260 }, (_, index) => text('assistant', index))
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
