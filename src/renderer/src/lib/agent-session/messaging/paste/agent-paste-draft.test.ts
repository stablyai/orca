import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  pasteDraftWhenAgentReady,
  sendBracketedPasteToRunningAgent,
  submitPromptToAgentPty
} from './agent-paste-draft'
import {
  AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES,
  AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES,
  sendAgentDraftPasteContent
} from './agent-draft-paste-content'
import { AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS as POST_PASTE_SUBMIT_DELAY_MS } from '../../../../../../shared/agent-launch/startup/agent-prompt-injection'
import { TUI_AGENT_CONFIG } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type * as RemoteRuntimePtyIdModule from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'

const testState = vi.hoisted(() => ({
  appState: {
    settings: {},
    ptyIdsByTabId: { 'tab-1': ['pty-1'] } as Record<string, string[]>,
    runtimePaneTitlesByTabId: {},
    tabsByWorktree: {} as Record<string, { id: string; title?: string }[]>,
    repos: [] as { id: string; connectionId: string | null; executionHostId?: string | null }[],
    worktreesByRepo: {} as Record<string, { id: string; repoId: string }[]>
  },
  storeSubscribers: new Set<(state: { ptyIdsByTabId: Record<string, string[]> }) => void>(),
  ptyObserver: null as ((data: string) => void) | null,
  unsubscribe: vi.fn(),
  subscribeToPtyData: vi.fn(),
  replayPreHandlerPtyData: vi.fn(),
  isRemoteRuntimePtyId: vi.fn(),
  getPtyKittyKeyboardFlags: vi.fn(),
  sendRuntimePtyInputVerified: vi.fn(),
  inspectRuntimeTerminalProcess: vi.fn(),
  subscribeToRuntimeTerminalData: vi.fn()
}))

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => testState.appState,
    subscribe: (
      subscriber: (state: { ptyIdsByTabId: Record<string, string[]> }) => void
    ): (() => void) => {
      testState.storeSubscribers.add(subscriber)
      return () => testState.storeSubscribers.delete(subscriber)
    }
  }
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: testState.subscribeToPtyData
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-pre-handler-buffer', () => ({
  replayPreHandlerPtyData: testState.replayPreHandlerPtyData
}))

vi.mock('@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection', () => ({
  inspectRuntimeTerminalProcess: testState.inspectRuntimeTerminalProcess
}))
vi.mock(
  '../../../../../../shared/remote-runtime/remote-runtime-pty-id',
  async (importOriginal) => ({
    ...(await importOriginal<typeof RemoteRuntimePtyIdModule>()),
    isRemoteRuntimePtyId: testState.isRemoteRuntimePtyId
  })
)
vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: (ptyId: string, data: string) =>
    testState.sendRuntimePtyInputVerified(ptyId, data)
}))

vi.mock('@/runtime/hosted-terminals/streams/runtime-terminal-data-subscription', () => ({
  subscribeToRuntimeTerminalData: testState.subscribeToRuntimeTerminalData
}))

vi.mock('@/components/terminal-pane/input/keyboard/terminal-pty-kitty-keyboard-flags', () => ({
  getPtyKittyKeyboardFlags: testState.getPtyKittyKeyboardFlags
}))

const DECSET_BRACKETED_PASTE = '\x1b[?2004h'
const CODEX_COMPOSER_PROMPT_RENDER = '\x1b[1m›\x1b[0m Ask Codex to do anything'
const CODEX_DYNAMIC_COMPOSER_PROMPT_RENDER = '\x1b[?1049h\x1b[1m›\x1b[0m Implement {feature}'
const ISSUE_URL = 'https://github.com/stablyai/orca/issues/123'
const PASTED_ISSUE_URL = `\x1b[200~${ISSUE_URL}\x1b[201~`
const ENTER_SUBMIT_INPUT = '\r'
const CODEX_SUBMIT_INPUT = '\x1b[13;5u'
const CODEX_SUBMIT_RETRY_DELAY_MS = TUI_AGENT_CONFIG.codex.submitRetryDelayMs ?? 0

describe('pasteDraftWhenAgentReady', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    })
    testState.appState.settings = {}
    testState.appState.ptyIdsByTabId = { 'tab-1': ['pty-1'] }
    testState.appState.runtimePaneTitlesByTabId = {}
    testState.appState.tabsByWorktree = {}
    testState.appState.repos = []
    testState.appState.worktreesByRepo = {}
    testState.storeSubscribers.clear()
    testState.ptyObserver = null
    testState.unsubscribe.mockReset()
    testState.subscribeToPtyData.mockReset()
    testState.subscribeToPtyData.mockImplementation(
      (_ptyId: string, observer: (data: string) => void) => {
        testState.ptyObserver = observer
        return testState.unsubscribe
      }
    )
    testState.replayPreHandlerPtyData.mockReset()
    testState.isRemoteRuntimePtyId.mockReset()
    testState.isRemoteRuntimePtyId.mockReturnValue(false)
    testState.getPtyKittyKeyboardFlags.mockReset()
    testState.getPtyKittyKeyboardFlags.mockReturnValue(0)
    testState.sendRuntimePtyInputVerified.mockReset()
    testState.sendRuntimePtyInputVerified.mockResolvedValue(true)
    testState.inspectRuntimeTerminalProcess.mockReset()
    testState.inspectRuntimeTerminalProcess.mockResolvedValue({
      foregroundProcess: 'bash',
      hasChildProcesses: false
    })
    testState.subscribeToRuntimeTerminalData.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('replays buffered Codex output during PTY binding before the primary drain', async () => {
    testState.appState.ptyIdsByTabId = {}
    testState.replayPreHandlerPtyData.mockImplementation(
      (_ptyId: string, observer: (data: string) => void) => {
        observer(CODEX_DYNAMIC_COMPOSER_PROMPT_RENDER)
        observer(DECSET_BRACKETED_PASTE)
      }
    )
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'codex',
      submit: true
    })

    expect(testState.storeSubscribers.size).toBe(1)
    testState.appState.ptyIdsByTabId = { 'tab-1': ['pty-1'] }
    for (const subscriber of testState.storeSubscribers) {
      subscriber(testState.appState)
    }
    expect(testState.storeSubscribers.size).toBe(0)
    expect(testState.ptyObserver).not.toBeNull()
    expect(testState.replayPreHandlerPtyData).toHaveBeenCalledWith('pty-1', testState.ptyObserver)
    await flushMicrotasks()

    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith('pty-1', PASTED_ISSUE_URL)
    await vi.advanceTimersByTimeAsync(POST_PASTE_SUBMIT_DELAY_MS + CODEX_SUBMIT_RETRY_DELAY_MS)
    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(
      2,
      'pty-1',
      ENTER_SUBMIT_INPUT
    )
    expect(testState.unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts the composer budget once the PTY exists, so a slow spawn does not shorten it', async () => {
    // PTY appearance and composer readiness need separate budgets or a slow spawn consumes the cold-start grace (STA-3367).
    testState.appState.ptyIdsByTabId = {}
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'codex'
    })

    await vi.advanceTimersByTimeAsync(4000)
    testState.appState.ptyIdsByTabId = { 'tab-1': ['pty-1'] }
    for (const subscriber of testState.storeSubscribers) {
      subscriber(testState.appState)
    }

    testState.ptyObserver?.(DECSET_BRACKETED_PASTE)
    // The composer gets its own window after PTY appearance, beyond the old shared budget.
    await vi.advanceTimersByTimeAsync(19000)
    await flushMicrotasks()
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()

    testState.ptyObserver?.(CODEX_COMPOSER_PROMPT_RENDER)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith('pty-1', PASTED_ISSUE_URL)
  })

  it('holds the PTY transaction across the paste and its submit Enter', async () => {
    const writes: string[] = []
    testState.sendRuntimePtyInputVerified.mockImplementation(
      async (_ptyId: string, data: string) => {
        writes.push(data)
        return true
      }
    )

    const submit = sendBracketedPasteToRunningAgent({ ptyId: 'pty-1', content: ISSUE_URL })
    await flushMicrotasks()
    // Competing chunked paste on the same PTY: it must not open a frame the Enter can land in.
    const competing = sendAgentDraftPasteContent(
      'pty-1',
      'y'.repeat(AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES + 1),
      'driving'
    )
    await flushMicrotasks(10)
    expect(writes).toEqual([PASTED_ISSUE_URL])

    await vi.advanceTimersByTimeAsync(POST_PASTE_SUBMIT_DELAY_MS)
    await expect(submit).resolves.toBe(true)
    await expect(competing).resolves.toBe(true)

    expect(writes.indexOf('\r')).toBe(1)
    expect(writes.at(2)).toBe('\x1b[200~')
    expect(writes.at(-1)).toBe('\x1b[201~')
  })

  it('falls back to Enter when configured Codex Ctrl+Enter has no Kitty keyboard proof', async () => {
    testState.appState.settings = { agentPostPasteSubmitInputs: { codex: 'ctrl-enter' } }
    const promise = submitPromptToAgentPty({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      content: ISSUE_URL,
      agent: 'codex'
    })

    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(POST_PASTE_SUBMIT_DELAY_MS + CODEX_SUBMIT_RETRY_DELAY_MS)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(
      1,
      'pty-1',
      PASTED_ISSUE_URL
    )
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(
      2,
      'pty-1',
      ENTER_SUBMIT_INPUT
    )
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(
      3,
      'pty-1',
      ENTER_SUBMIT_INPUT
    )
  })

  it('uses configured Codex Ctrl+Enter for exact PTY submits with Kitty keyboard proof', async () => {
    testState.appState.settings = { agentPostPasteSubmitInputs: { codex: 'ctrl-enter' } }
    testState.getPtyKittyKeyboardFlags.mockReturnValue(1)
    const promise = submitPromptToAgentPty({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      content: ISSUE_URL,
      agent: 'codex'
    })

    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(POST_PASTE_SUBMIT_DELAY_MS + CODEX_SUBMIT_RETRY_DELAY_MS)

    await expect(promise).resolves.toBe(true)
    expect(testState.getPtyKittyKeyboardFlags).toHaveBeenCalledWith('pty-1')
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(
      1,
      'pty-1',
      PASTED_ISSUE_URL
    )
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(
      2,
      'pty-1',
      CODEX_SUBMIT_INPUT
    )
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(
      3,
      'pty-1',
      CODEX_SUBMIT_INPUT
    )
  })

  it('streams large running-agent drafts as bounded bracketed chunks before submit', async () => {
    const content = 'x'.repeat(
      AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES + AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES + 7
    )
    const promise = sendBracketedPasteToRunningAgent({
      ptyId: 'pty-1',
      content
    })

    await flushMicrotasks(20)

    const calls = testState.sendRuntimePtyInputVerified.mock.calls
    expect(calls.at(0)).toEqual(['pty-1', '\x1b[200~'])
    expect(calls.at(-1)?.[1]).toBe('\x1b[201~')
    expect(
      calls
        .slice(1, -1)
        .map((call) => call[1])
        .join('')
    ).toBe(content)
    for (const call of calls.slice(1, -1)) {
      expect(String(call[1]).length).toBeLessThanOrEqual(AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES)
    }

    await vi.advanceTimersByTimeAsync(50)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenLastCalledWith('pty-1', '\r')
  })

  it('closes bracketed paste and does not submit when a chunked draft write is rejected', async () => {
    testState.sendRuntimePtyInputVerified
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const content = 'x'.repeat(
      AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES + AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES + 7
    )

    await expect(
      sendBracketedPasteToRunningAgent({
        ptyId: 'pty-1',
        content
      })
    ).resolves.toBe(false)

    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledTimes(3)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(1, 'pty-1', '[200~')
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(3, 'pty-1', '[201~')
    expect(testState.sendRuntimePtyInputVerified.mock.calls.some((call) => call[1] === '\r')).toBe(
      false
    )
  })
})

async function flushMicrotasks(iterations = 2): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve()
  }
}
