import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES,
  getSettingsForAgentTabRuntimeOwner,
  pasteDraftToAgentPtyWhenReady,
  pasteDraftWhenAgentReady,
  POST_PASTE_SUBMIT_DELAY_MS,
  sendAgentDraftPasteContent,
  sendBracketedPasteToRunningAgent,
  submitPromptToAgentPty
} from './agent-paste-draft'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'

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

vi.mock('@/store', () => ({
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

vi.mock('@/components/terminal-pane/terminal-pty-kitty-keyboard-flags', () => ({
  getPtyKittyKeyboardFlags: testState.getPtyKittyKeyboardFlags
}))

const DECSET_BRACKETED_PASTE = '\x1b[?2004h'
const SHOW_CURSOR = '\x1b[?25h'
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

  it('pastes into Codex as soon as its composer prompt renders after bracketed paste is enabled', async () => {
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'codex'
    })
    await flushMicrotasks()

    testState.ptyObserver?.(CODEX_COMPOSER_PROMPT_RENDER)
    await flushMicrotasks()
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()

    testState.ptyObserver?.(DECSET_BRACKETED_PASTE)
    await flushMicrotasks()
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()

    testState.ptyObserver?.(CODEX_COMPOSER_PROMPT_RENDER)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      PASTED_ISSUE_URL
    )
    expect(vi.getTimerCount()).toBe(0)
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

    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      PASTED_ISSUE_URL
    )
    await vi.advanceTimersByTimeAsync(POST_PASTE_SUBMIT_DELAY_MS + CODEX_SUBMIT_RETRY_DELAY_MS)
    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(
      2,
      {},
      'pty-1',
      ENTER_SUBMIT_INPUT
    )
    expect(testState.unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('detects the Codex composer prompt inside a large first render chunk', async () => {
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'codex'
    })
    await flushMicrotasks()

    testState.ptyObserver?.(
      `${DECSET_BRACKETED_PASTE}${CODEX_COMPOSER_PROMPT_RENDER}${'x'.repeat(900)}`
    )

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      PASTED_ISSUE_URL
    )
  })

  it('keeps the render-quiet wait for agents without the Codex ready signal', async () => {
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'gemini'
    })
    await flushMicrotasks()

    testState.ptyObserver?.(DECSET_BRACKETED_PASTE)
    await flushMicrotasks()
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1499)
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      PASTED_ISSUE_URL
    )
  })

  it('pastes into opencode as soon as show-cursor renders after bracketed paste is enabled', async () => {
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'opencode'
    })
    await flushMicrotasks()

    testState.ptyObserver?.(DECSET_BRACKETED_PASTE)
    await flushMicrotasks()
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()

    testState.ptyObserver?.(SHOW_CURSOR)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      PASTED_ISSUE_URL
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('detects opencode show-cursor inside a large first render chunk', async () => {
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'opencode'
    })
    await flushMicrotasks()

    testState.ptyObserver?.(`${DECSET_BRACKETED_PASTE}${SHOW_CURSOR}${'x'.repeat(900)}`)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      PASTED_ISSUE_URL
    )
  })

  it('detects opencode show-cursor split across a later chunk', async () => {
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'opencode'
    })
    await flushMicrotasks()

    testState.ptyObserver?.(DECSET_BRACKETED_PASTE)
    await flushMicrotasks()
    testState.ptyObserver?.('render noise \x1b[?')
    await flushMicrotasks()
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()

    testState.ptyObserver?.('25h')

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      PASTED_ISSUE_URL
    )
  })

  it('rescues opencode delivery under never-settling output churn', async () => {
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'opencode'
    })
    await flushMicrotasks()

    testState.ptyObserver?.(DECSET_BRACKETED_PASTE)
    await flushMicrotasks()
    for (let index = 0; index < 5; index += 1) {
      await vi.advanceTimersByTimeAsync(1499)
      testState.ptyObserver?.(`setup output ${index}`)
      await flushMicrotasks()
      expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()
    }

    testState.ptyObserver?.(SHOW_CURSOR)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      PASTED_ISSUE_URL
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not paste on the quiet window for opencode (it never arms one)', async () => {
    // Why: opencode is silent for ~1.5-2s between enabling bracketed paste and
    // mounting its composer. A quiet window would fire during that gap and paste
    // before the composer exists (the original bug), so the cursor signal must
    // not arm one. With process inspection failing, delivery times out instead.
    testState.inspectRuntimeTerminalProcess.mockResolvedValue(null)
    const onTimeout = vi.fn()
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'opencode',
      onTimeout
    })
    await flushMicrotasks()

    testState.ptyObserver?.(DECSET_BRACKETED_PASTE)
    await flushMicrotasks()

    // Quiet-window duration elapses with no show-cursor: must NOT paste.
    await vi.advanceTimersByTimeAsync(1500)
    await flushMicrotasks()
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()

    // Only the hard timeout (and failed process check) resolves it — to false.
    await vi.advanceTimersByTimeAsync(8000)
    await flushMicrotasks(5)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(promise).resolves.toBe(false)
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('best-effort pastes for opencode at the hard timeout when its process is running', async () => {
    // Why: with no quiet window, the hard-timeout process-ownership check is the
    // backstop if show-cursor is somehow missed — same model as Codex.
    testState.inspectRuntimeTerminalProcess.mockResolvedValue({
      foregroundProcess: 'opencode',
      hasChildProcesses: false
    })
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'opencode'
    })
    await flushMicrotasks()

    testState.ptyObserver?.(DECSET_BRACKETED_PASTE)
    await vi.advanceTimersByTimeAsync(8000)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      PASTED_ISSUE_URL
    )
  })

  it('keeps the existing fallback budget for unrelated markerless agents', async () => {
    testState.inspectRuntimeTerminalProcess.mockResolvedValue({
      foregroundProcess: 'claude',
      hasChildProcesses: false
    })
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'claude',
      forcePaste: true
    })
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(7999)
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks(5)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      PASTED_ISSUE_URL
    )
  })

  it('does not paste for agents that already use native draft prefill', async () => {
    await expect(
      pasteDraftWhenAgentReady({
        tabId: 'tab-1',
        content: ISSUE_URL,
        agent: 'pi'
      })
    ).resolves.toBe(false)

    expect(testState.subscribeToPtyData).not.toHaveBeenCalled()
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()
  })

  it('submits in a separate write after force-pasting native-prefill agents', async () => {
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'claude',
      submit: true,
      forcePaste: true
    })
    await flushMicrotasks()

    testState.ptyObserver?.(DECSET_BRACKETED_PASTE)
    await vi.advanceTimersByTimeAsync(1500)
    await flushMicrotasks()

    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledTimes(1)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      PASTED_ISSUE_URL
    )
    await vi.advanceTimersByTimeAsync(49)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(2, {}, 'pty-1', '\r')
  })

  it('does not submit when the verified paste write fails', async () => {
    testState.sendRuntimePtyInputVerified.mockResolvedValueOnce(false)

    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'claude',
      submit: true,
      forcePaste: true
    })
    await flushMicrotasks()

    testState.ptyObserver?.(DECSET_BRACKETED_PASTE)
    await vi.advanceTimersByTimeAsync(1500)

    await expect(promise).resolves.toBe(false)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledTimes(1)
  })

  it('reports false when verified input delivery fails', async () => {
    testState.sendRuntimePtyInputVerified.mockResolvedValue(false)
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'codex'
    })
    await flushMicrotasks()

    testState.ptyObserver?.(`${DECSET_BRACKETED_PASTE}${CODEX_COMPOSER_PROMPT_RENDER}`)

    await expect(promise).resolves.toBe(false)
  })

  it('reports false when verified input delivery rejects', async () => {
    testState.sendRuntimePtyInputVerified.mockRejectedValue(new Error('runtime timeout'))
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'codex'
    })
    await flushMicrotasks()

    testState.ptyObserver?.(`${DECSET_BRACKETED_PASTE}${CODEX_COMPOSER_PROMPT_RENDER}`)

    await expect(promise).resolves.toBe(false)
  })

  it('best-effort pastes when the ready escape was missed but the agent process is running', async () => {
    testState.inspectRuntimeTerminalProcess.mockResolvedValue({
      foregroundProcess: 'codex',
      hasChildProcesses: false
    })

    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'codex'
    })
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(20000)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      PASTED_ISSUE_URL
    )
  })

  it('waits past the default budget for a cold-boot Codex composer glyph (STA-3367)', async () => {
    // Why: first-run/cold codex can take >8s to mount its composer. The '›' glyph
    // is a positive readiness proof, so the marker-gated budget waits for it
    // instead of giving up at 8s and dropping the handoff prompt. Process
    // inspection stays 'bash' so only the real marker — not the fallback — delivers.
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'codex'
    })
    await flushMicrotasks()

    testState.ptyObserver?.(DECSET_BRACKETED_PASTE)
    // Old 8s budget would have already timed out and dropped the prompt here.
    await vi.advanceTimersByTimeAsync(8000)
    await flushMicrotasks()
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()

    testState.ptyObserver?.(CODEX_COMPOSER_PROMPT_RENDER)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      PASTED_ISSUE_URL
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives up on a never-spawned PTY at the spawn budget, not the composer budget (STA-3367)', async () => {
    // Why: the two waits must not each spend the marker budget. A tab whose PTY
    // never appears is a failed launch, and must not also burn the 20s cold-boot
    // composer window before the caller is told.
    testState.appState.ptyIdsByTabId = {}
    const onTimeout = vi.fn()
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'codex',
      onTimeout
    })

    await vi.advanceTimersByTimeAsync(8000)
    await flushMicrotasks(5)

    await expect(promise).resolves.toBe(false)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts the composer budget once the PTY exists, so a slow spawn does not shorten it', async () => {
    // Why: "tab has a PTY" and "composer accepts input" are separate states. A
    // spawn that eats most of a shared budget would leave a cold codex too little
    // room and re-drop the prompt — the exact STA-3367 failure.
    testState.appState.ptyIdsByTabId = {}
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'codex'
    })

    // PTY takes 4s to appear — most of the old shared 8s budget.
    await vi.advanceTimersByTimeAsync(4000)
    testState.appState.ptyIdsByTabId = { 'tab-1': ['pty-1'] }
    for (const subscriber of testState.storeSubscribers) {
      subscriber(testState.appState)
    }

    testState.ptyObserver?.(DECSET_BRACKETED_PASTE)
    // 19s of cold boot after the PTY appeared: past a shared budget, inside the
    // composer's own window.
    await vi.advanceTimersByTimeAsync(19000)
    await flushMicrotasks()
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()

    testState.ptyObserver?.(CODEX_COMPOSER_PROMPT_RENDER)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      PASTED_ISSUE_URL
    )
  })

  it('honors the fallback inspection deadline for pty-bound draft paste', async () => {
    const onTimeout = vi.fn()
    testState.inspectRuntimeTerminalProcess.mockReturnValue(new Promise(() => {}))

    const promise = pasteDraftToAgentPtyWhenReady({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      content: ISSUE_URL,
      agent: 'codex',
      forcePaste: true,
      timeoutMs: 1,
      onTimeout
    })
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks(5)
    await vi.advanceTimersByTimeAsync(1000)

    await expect(promise).resolves.toBe(false)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()
  })

  it('routes tab-owned paste writes through the worktree runtime owner', async () => {
    testState.appState.settings = { activeRuntimeEnvironmentId: 'focused-runtime' }
    testState.appState.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    testState.appState.repos = [
      { id: 'repo-1', connectionId: null, executionHostId: 'runtime:owner-runtime' }
    ]
    testState.appState.worktreesByRepo = { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }

    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'codex'
    })
    await flushMicrotasks()

    testState.ptyObserver?.(`${DECSET_BRACKETED_PASTE}${CODEX_COMPOSER_PROMPT_RENDER}`)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: 'owner-runtime' },
      'pty-1',
      PASTED_ISSUE_URL
    )
  })

  it('routes legacy remote PTY readiness subscription through the tab owner', async () => {
    testState.appState.settings = { activeRuntimeEnvironmentId: 'focused-runtime' }
    testState.appState.ptyIdsByTabId = { 'tab-1': ['remote:terminal-handle'] }
    testState.appState.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    testState.appState.repos = [
      { id: 'repo-1', connectionId: null, executionHostId: 'runtime:owner-runtime' }
    ]
    testState.appState.worktreesByRepo = { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
    testState.isRemoteRuntimePtyId.mockReturnValue(true)
    testState.subscribeToRuntimeTerminalData.mockImplementation(
      async (
        _settings: unknown,
        _ptyId: string,
        _clientId: string,
        observer: (data: string) => void
      ) => {
        testState.ptyObserver = observer
        return testState.unsubscribe
      }
    )

    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'codex'
    })
    await flushMicrotasks()

    testState.ptyObserver?.(`${DECSET_BRACKETED_PASTE}${CODEX_COMPOSER_PROMPT_RENDER}`)

    await expect(promise).resolves.toBe(true)
    expect(testState.subscribeToRuntimeTerminalData).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: 'owner-runtime' },
      'remote:terminal-handle',
      'desktop:paste-ready:remote:terminal-handle',
      expect.any(Function)
    )
  })

  it('submits to an already running agent without waiting for readiness signals', async () => {
    const promise = sendBracketedPasteToRunningAgent({
      ptyId: 'pty-1',
      content: ISSUE_URL
    })

    expect(testState.subscribeToPtyData).not.toHaveBeenCalled()
    expect(testState.subscribeToRuntimeTerminalData).not.toHaveBeenCalled()
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledTimes(1)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      PASTED_ISSUE_URL
    )

    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(49)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(2, {}, 'pty-1', '\r')
  })

  it('holds the PTY transaction across the paste and its submit Enter', async () => {
    const writes: string[] = []
    testState.sendRuntimePtyInputVerified.mockImplementation(
      async (_settings: unknown, _ptyId: string, data: string) => {
        writes.push(data)
        return true
      }
    )

    const submit = sendBracketedPasteToRunningAgent({ ptyId: 'pty-1', content: ISSUE_URL })
    await flushMicrotasks()
    // Competing chunked paste on the same PTY: it must not open a frame the Enter can land in.
    const competing = sendAgentDraftPasteContent(
      {},
      'pty-1',
      'y'.repeat(AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES + 1)
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

  it('submits to an exact PTY even when it is not the first PTY in the tab', async () => {
    testState.appState.ptyIdsByTabId = { 'tab-1': ['pty-left', 'pty-right'] }
    testState.appState.tabsByWorktree = {
      'wt-1': [{ id: 'tab-1' }]
    }
    testState.appState.repos = [
      { id: 'repo-1', connectionId: null, executionHostId: 'runtime:owner-runtime' }
    ]
    testState.appState.worktreesByRepo = { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
    testState.appState.settings = { activeRuntimeEnvironmentId: 'owner-runtime' }

    const promise = submitPromptToAgentPty({
      tabId: 'tab-1',
      ptyId: 'pty-right',
      content: ISSUE_URL
    })

    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(50)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(
      1,
      { activeRuntimeEnvironmentId: 'owner-runtime' },
      'pty-right',
      PASTED_ISSUE_URL
    )
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(
      2,
      { activeRuntimeEnvironmentId: 'owner-runtime' },
      'pty-right',
      '\r'
    )
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
      { agentPostPasteSubmitInputs: { codex: 'ctrl-enter' } },
      'pty-1',
      PASTED_ISSUE_URL
    )
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(
      2,
      { agentPostPasteSubmitInputs: { codex: 'ctrl-enter' } },
      'pty-1',
      ENTER_SUBMIT_INPUT
    )
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(
      3,
      { agentPostPasteSubmitInputs: { codex: 'ctrl-enter' } },
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
      { agentPostPasteSubmitInputs: { codex: 'ctrl-enter' } },
      'pty-1',
      PASTED_ISSUE_URL
    )
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(
      2,
      { agentPostPasteSubmitInputs: { codex: 'ctrl-enter' } },
      'pty-1',
      CODEX_SUBMIT_INPUT
    )
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(
      3,
      { agentPostPasteSubmitInputs: { codex: 'ctrl-enter' } },
      'pty-1',
      CODEX_SUBMIT_INPUT
    )
  })
})

describe('getSettingsForAgentTabRuntimeOwner', () => {
  beforeEach(() => {
    testState.appState.settings = { activeRuntimeEnvironmentId: 'focused-runtime' }
    testState.appState.tabsByWorktree = {}
    testState.appState.repos = []
    testState.appState.worktreesByRepo = {}
  })

  it('falls back to focused settings when the tab is not mapped to a worktree', () => {
    expect(getSettingsForAgentTabRuntimeOwner('missing-tab')).toEqual({
      activeRuntimeEnvironmentId: 'focused-runtime'
    })
  })

  it('uses the tab worktree owner when mapped', () => {
    testState.appState.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    testState.appState.repos = [
      { id: 'repo-1', connectionId: null, executionHostId: 'runtime:owner-runtime' }
    ]
    testState.appState.worktreesByRepo = { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }

    expect(getSettingsForAgentTabRuntimeOwner('tab-1')).toEqual({
      activeRuntimeEnvironmentId: 'owner-runtime'
    })
  })
})

async function flushMicrotasks(iterations = 2): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve()
  }
}
