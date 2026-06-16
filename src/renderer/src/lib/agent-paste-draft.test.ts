import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getSettingsForAgentTabRuntimeOwner,
  pasteDraftWhenAgentReady,
  sendBracketedPasteToRunningAgent
} from './agent-paste-draft'

const testState = vi.hoisted(() => ({
  appState: {
    settings: {},
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    runtimePaneTitlesByTabId: {},
    tabsByWorktree: {} as Record<string, { id: string; title?: string }[]>,
    repos: [] as { id: string; connectionId: string | null; executionHostId?: string | null }[],
    worktreesByRepo: {} as Record<string, { id: string; repoId: string }[]>
  },
  ptyObserver: null as ((data: string) => void) | null,
  unsubscribe: vi.fn(),
  subscribeToPtyData: vi.fn(),
  isRemoteRuntimePtyId: vi.fn(),
  sendRuntimePtyInputVerified: vi.fn(),
  inspectRuntimeTerminalProcess: vi.fn(),
  subscribeToRuntimeTerminalData: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => testState.appState
  }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  subscribeToPtyData: testState.subscribeToPtyData
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
const ISSUE_URL = 'https://github.com/stablyai/orca/issues/123'
const PASTED_ISSUE_URL = `\x1b[200~${ISSUE_URL}\x1b[201~`

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
    testState.ptyObserver = null
    testState.unsubscribe.mockReset()
    testState.subscribeToPtyData.mockReset()
    testState.subscribeToPtyData.mockImplementation(
      (_ptyId: string, observer: (data: string) => void) => {
        testState.ptyObserver = observer
        return testState.unsubscribe
      }
    )
    testState.isRemoteRuntimePtyId.mockReset()
    testState.isRemoteRuntimePtyId.mockReturnValue(false)
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
      agent: 'opencode'
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

    await vi.advanceTimersByTimeAsync(8000)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      PASTED_ISSUE_URL
    )
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
