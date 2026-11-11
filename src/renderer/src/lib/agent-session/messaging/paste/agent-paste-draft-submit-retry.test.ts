import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { pasteDraftWhenAgentReady } from './agent-paste-draft'
import {
  AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES,
  sendAgentDraftPasteContent
} from './agent-draft-paste-content'
import { AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS as POST_PASTE_SUBMIT_DELAY_MS } from '../../../../../../shared/agent-launch/startup/agent-prompt-injection'
import { TUI_AGENT_CONFIG } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type * as RemoteRuntimePtyIdModule from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'

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

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => testState.appState,
    subscribe: () => () => {}
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
  sendRuntimePtyInputVerified: testState.sendRuntimePtyInputVerified
}))

vi.mock('@/runtime/hosted-terminals/streams/runtime-terminal-data-subscription', () => ({
  subscribeToRuntimeTerminalData: testState.subscribeToRuntimeTerminalData
}))

const DECSET_BRACKETED_PASTE = '\x1b[?2004h'
const CODEX_COMPOSER_PROMPT_RENDER = '\x1b[1m›\x1b[0m Ask Codex to do anything'

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

  it('holds the PTY input transaction across the retry Enter', async () => {
    const writes: string[] = []
    testState.sendRuntimePtyInputVerified.mockImplementation(
      async (_ptyId: string, data: string) => {
        writes.push(data)
        return true
      }
    )

    const promise = startCodexSubmit()
    await signalCodexComposerReady()
    await vi.advanceTimersByTimeAsync(POST_PASTE_SUBMIT_DELAY_MS)
    // Competing paste on the same PTY: it must not open a frame the retry can land in.
    const competing = sendAgentDraftPasteContent(
      'pty-1',
      'y'.repeat(AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES + 1),
      'driving'
    )
    await flushMicrotasks(10)
    expect(writes).toEqual([PASTED_ISSUE_URL, '\r'])

    await vi.advanceTimersByTimeAsync(CODEX_SUBMIT_RETRY_DELAY_MS)
    await expect(promise).resolves.toBe(true)
    await expect(competing).resolves.toBe(true)

    expect(writes.slice(0, 3)).toEqual([PASTED_ISSUE_URL, '\r', '\r'])
    expect(writes.at(3)).toBe('\x1b[200~')
  })
})

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
