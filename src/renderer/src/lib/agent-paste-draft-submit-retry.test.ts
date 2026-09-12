import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES,
  pasteDraftWhenAgentReady,
  POST_PASTE_SUBMIT_DELAY_MS,
  sendAgentDraftPasteContent
} from './agent-paste-draft'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'

const testState = vi.hoisted(() => ({
  appState: {
    settings: {} as Record<string, unknown>,
    ptyIdsByTabId: { 'tab-1': ['pty-1'] } as Record<string, string[]>,
    runtimePaneTitlesByTabId: {},
    tabsByWorktree: {} as Record<string, { id: string }[]>,
    repos: [] as { id: string; connectionId: string | null; executionHostId?: string | null }[],
    worktreesByRepo: {} as Record<string, { id: string; repoId: string }[]>
  },
  ptyObserver: null as ((data: string) => void) | null,
  unsubscribe: vi.fn(),
  subscribeToPtyData: vi.fn(),
  replayPreHandlerPtyData: vi.fn(),
  isRemoteRuntimePtyId: vi.fn(),
  sendRuntimePtyInputVerified: vi.fn(),
  inspectRuntimeTerminalProcess: vi.fn(),
  subscribeToRuntimeTerminalData: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => testState.appState,
    subscribe: () => () => {}
  }
}))

vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: testState.subscribeToPtyData
}))

vi.mock('@/components/terminal-pane/pty-pre-handler-buffer', () => ({
  replayPreHandlerPtyData: testState.replayPreHandlerPtyData
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: testState.isRemoteRuntimePtyId,
  sendRuntimePtyInputVerified: testState.sendRuntimePtyInputVerified,
  inspectRuntimeTerminalProcess: testState.inspectRuntimeTerminalProcess
}))

vi.mock('@/runtime/runtime-terminal-stream', () => ({
  subscribeToRuntimeTerminalData: testState.subscribeToRuntimeTerminalData
}))

const DECSET_BRACKETED_PASTE = '\x1b[?2004h'
const CODEX_COMPOSER_PROMPT_RENDER = '\x1b[1m›\x1b[0m Ask Codex to do anything'
const RENDER_QUIET_MS = 1500
const ISSUE_URL = 'https://github.com/stablyai/orca/issues/123'
const PASTED_ISSUE_URL = `\x1b[200~${ISSUE_URL}\x1b[201~`
const CODEX_SUBMIT_RETRY_DELAY_MS = TUI_AGENT_CONFIG.codex.submitRetryDelayMs ?? 0

describe('post-paste submit retry Enter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    })
    testState.appState.settings = {}
    testState.appState.ptyIdsByTabId = { 'tab-1': ['pty-1'] }
    testState.appState.tabsByWorktree = {}
    testState.appState.repos = []
    testState.appState.worktreesByRepo = {}
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
    testState.sendRuntimePtyInputVerified.mockReset()
    testState.sendRuntimePtyInputVerified.mockResolvedValue(true)
    testState.inspectRuntimeTerminalProcess.mockReset()
    testState.subscribeToRuntimeTerminalData.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('sends one retry Enter after the configured gap for agents that can eat the first Enter', async () => {
    const promise = startCodexSubmit()
    await signalCodexComposerReady()
    await vi.advanceTimersByTimeAsync(POST_PASTE_SUBMIT_DELAY_MS)

    expect(enterWrites()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(CODEX_SUBMIT_RETRY_DELAY_MS - 1)
    expect(enterWrites()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(promise).resolves.toBe(true)
    expect(enterWrites()).toHaveLength(2)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenLastCalledWith({}, 'pty-1', '\r')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sends exactly one Enter for agents without a submit retry delay', async () => {
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'gemini',
      submit: true
    })
    await flushMicrotasks()
    testState.ptyObserver?.(DECSET_BRACKETED_PASTE)
    await vi.advanceTimersByTimeAsync(RENDER_QUIET_MS)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(POST_PASTE_SUBMIT_DELAY_MS + CODEX_SUBMIT_RETRY_DELAY_MS)

    await expect(promise).resolves.toBe(true)
    expect(enterWrites()).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('holds the PTY input transaction across the retry Enter', async () => {
    const writes: string[] = []
    testState.sendRuntimePtyInputVerified.mockImplementation(
      async (_settings: unknown, _ptyId: string, data: string) => {
        writes.push(data)
        return true
      }
    )

    const promise = startCodexSubmit()
    await signalCodexComposerReady()
    await vi.advanceTimersByTimeAsync(POST_PASTE_SUBMIT_DELAY_MS)
    // Competing paste on the same PTY: it must not open a frame the retry can land in.
    const competing = sendAgentDraftPasteContent(
      {},
      'pty-1',
      'y'.repeat(AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES + 1)
    )
    await flushMicrotasks(10)
    expect(writes).toEqual([PASTED_ISSUE_URL, '\r'])

    await vi.advanceTimersByTimeAsync(CODEX_SUBMIT_RETRY_DELAY_MS)
    await expect(promise).resolves.toBe(true)
    await expect(competing).resolves.toBe(true)

    expect(writes.slice(0, 3)).toEqual([PASTED_ISSUE_URL, '\r', '\r'])
    expect(writes.at(3)).toBe('\x1b[200~')
  })

  it('keeps a successful submit successful when the retry Enter is rejected', async () => {
    testState.sendRuntimePtyInputVerified
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('terminal_not_writable'))

    const promise = startCodexSubmit()
    await signalCodexComposerReady()
    await vi.advanceTimersByTimeAsync(POST_PASTE_SUBMIT_DELAY_MS + CODEX_SUBMIT_RETRY_DELAY_MS)

    await expect(promise).resolves.toBe(true)
    expect(enterWrites()).toHaveLength(2)
  })
})

function enterWrites(): unknown[][] {
  return testState.sendRuntimePtyInputVerified.mock.calls.filter((call) => call[2] === '\r')
}

function startCodexSubmit(): Promise<boolean> {
  return pasteDraftWhenAgentReady({
    tabId: 'tab-1',
    content: ISSUE_URL,
    agent: 'codex',
    submit: true
  })
}

async function signalCodexComposerReady(): Promise<void> {
  await flushMicrotasks()
  testState.ptyObserver?.(`${DECSET_BRACKETED_PASTE}${CODEX_COMPOSER_PROMPT_RENDER}`)
  await flushMicrotasks()
}

async function flushMicrotasks(iterations = 2): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve()
  }
}
