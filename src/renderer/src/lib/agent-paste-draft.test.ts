import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pasteDraftWhenAgentReady } from './agent-paste-draft'

const testState = vi.hoisted(() => ({
  appState: {
    settings: {},
    ptyIdsByTabId: { 'tab-1': ['pty-1'] }
  },
  ptyObserver: null as ((data: string) => void) | null,
  unsubscribe: vi.fn(),
  subscribeToPtyData: vi.fn(),
  isRemoteRuntimePtyId: vi.fn(),
  sendRuntimePtyInput: vi.fn(),
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
  sendRuntimePtyInput: testState.sendRuntimePtyInput
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
    testState.sendRuntimePtyInput.mockReset()
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
    expect(testState.sendRuntimePtyInput).not.toHaveBeenCalled()

    testState.ptyObserver?.(DECSET_BRACKETED_PASTE)
    await flushMicrotasks()
    expect(testState.sendRuntimePtyInput).not.toHaveBeenCalled()

    testState.ptyObserver?.(CODEX_COMPOSER_PROMPT_RENDER)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInput).toHaveBeenCalledWith({}, 'pty-1', PASTED_ISSUE_URL)
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
    expect(testState.sendRuntimePtyInput).toHaveBeenCalledWith({}, 'pty-1', PASTED_ISSUE_URL)
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
    expect(testState.sendRuntimePtyInput).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1499)
    expect(testState.sendRuntimePtyInput).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInput).toHaveBeenCalledWith({}, 'pty-1', PASTED_ISSUE_URL)
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
    expect(testState.sendRuntimePtyInput).not.toHaveBeenCalled()
  })
})

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
