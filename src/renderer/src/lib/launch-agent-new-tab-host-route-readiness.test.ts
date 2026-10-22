import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RemoteRuntimePtyIdModule from '../../../shared/remote-runtime-pty-id'

const TAB = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

const testState = vi.hoisted(() => {
  const ptyIdsByTabId: Record<string, string[]> = {}
  const writes: { at: number; ptyId?: string; data: string }[] = []
  return {
    appState: {
      settings: {},
      activeWorktreeId: 'wt-1',
      tabsByWorktree: {},
      ptyIdsByTabId,
      seedNativeChatLaunchPrompt: vi.fn(),
      seedNativeChatLaunchDraft: vi.fn(),
      markNativeChatLaunchPromptFailed: vi.fn()
    },
    storeSubscribers: new Set<(state: unknown) => void>(),
    ptyWatchers: new Map<string, (data: string) => void>(),
    writes,
    launchAgentThroughHost: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => testState.appState,
    subscribe: (subscriber: (state: unknown) => void) => {
      testState.storeSubscribers.add(subscriber)
      return () => testState.storeSubscribers.delete(subscriber)
    }
  }
}))
vi.mock('@/lib/agent-launch-through-host', () => ({
  launchAgentThroughHost: testState.launchAgentThroughHost,
  windowMakesHostLaunchTab: () => true
}))
vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: (ptyId: string, watcher: (data: string) => void) => {
    testState.ptyWatchers.set(ptyId, watcher)
    return () => testState.ptyWatchers.delete(ptyId)
  }
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn(async () => null)
}))
vi.mock('../../../shared/remote-runtime-pty-id', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteRuntimePtyIdModule>()),
  isRemoteRuntimePtyId: () => false
}))
vi.mock('@/runtime/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: async (ptyId: string, data: string) => {
    testState.writes.push({ at: Date.now(), ...(ptyId === 'pty-1' ? {} : { ptyId }), data })
    return true
  }
}))
vi.mock('@/runtime/runtime-terminal-stream', () => ({ subscribeToRuntimeTerminalData: vi.fn() }))
vi.mock('./agent-ready-wait', () => ({ waitForAgentReady: vi.fn(async () => ({ ready: false })) }))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), tuiAgentToAgentKind: () => 'claude' }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

const { launchNewTabPromptThroughHost } = await import('./launch-agent-new-tab-host-route')
const { bufferPreHandlerPtyData, drainPreHandlerPtyData, clearPreHandlerPtyState } =
  await import('@/components/terminal-pane/pty-pre-handler-buffer')

function attachHostPty(ptyId: string): void {
  testState.appState.ptyIdsByTabId = { [TAB]: [ptyId] }
  for (const subscriber of testState.storeSubscribers) {
    subscriber(testState.appState)
  }
}

describe('an AI button whose agent is ready before the host answers', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 })
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    })
    testState.appState.ptyIdsByTabId = {}
    testState.storeSubscribers.clear()
    testState.ptyWatchers.clear()
    testState.writes = []
    testState.appState.seedNativeChatLaunchPrompt.mockClear()
  })

  afterEach(() => {
    clearPreHandlerPtyState('launch-agent')
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // Regression: the paste watched the terminal only after the host's reply, so an agent that had
  // already enabled bracketed paste was never seen ready and its prompt waited out the budget.
  it('is pasted at its own ready signal plus the quiet window, not after the timeout', async () => {
    let answer!: (startedPtyId: string | null) => void
    testState.launchAgentThroughHost.mockReturnValue({
      tabId: TAB,
      started: new Promise<string | null>((done) => (answer = done))
    })
    const onPromptDeliveryUnconfirmed = vi.fn()
    const { promptDeliveryResult } = launchNewTabPromptThroughHost({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'resolve the conflicts',
      pasteContent: 'resolve the conflicts',
      submit: true,
      onPromptDeliveryUnconfirmed
    })

    await vi.advanceTimersByTimeAsync(50)
    attachHostPty('pty-1')
    await vi.advanceTimersByTimeAsync(10)
    testState.ptyWatchers.get('pty-1')?.('claude drawn\r\n\x1b[?2004h> ')
    await vi.advanceTimersByTimeAsync(240)
    expect(testState.writes).toEqual([])
    expect(testState.appState.seedNativeChatLaunchPrompt).not.toHaveBeenCalled()

    answer('pty-1')
    await vi.advanceTimersByTimeAsync(1200)
    expect(testState.writes).toEqual([])

    // Ready at 60 ms + the 1.5 s quiet window.
    await vi.advanceTimersByTimeAsync(60)
    expect(testState.writes[0]).toEqual({
      at: 1560,
      data: '\x1b[200~resolve the conflicts\x1b[201~'
    })
    expect(testState.appState.seedNativeChatLaunchPrompt).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(2000)
    await expect(promptDeliveryResult).resolves.toEqual({ delivered: true, failureNotified: false })
    expect(onPromptDeliveryUnconfirmed).not.toHaveBeenCalled()
  })

  it('writes nothing, and seeds no chat copy, when its pane says the agent did not start', async () => {
    let answer!: (startedPtyId: string | null) => void
    testState.launchAgentThroughHost.mockReturnValue({
      tabId: TAB,
      started: new Promise<string | null>((done) => (answer = done))
    })
    const { promptDeliveryResult } = launchNewTabPromptThroughHost({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'resolve the conflicts',
      pasteContent: 'resolve the conflicts',
      submit: true
    })

    attachHostPty('pty-1')
    testState.ptyWatchers.get('pty-1')?.('\x1b[?2004h> ')
    answer(null)
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(promptDeliveryResult).resolves.toEqual({ delivered: false, failureNotified: true })
    expect(testState.writes).toEqual([])
    expect(testState.appState.seedNativeChatLaunchPrompt).not.toHaveBeenCalled()
    expect(testState.appState.markNativeChatLaunchPromptFailed).not.toHaveBeenCalled()
  })

  // Regression: a split made while the agent started bound its shell first, and took the prompt.
  it("goes only to its own pane's PTY when another split's shell is ready first", async () => {
    let answer!: (startedPtyId: string | null) => void
    testState.launchAgentThroughHost.mockReturnValue({
      tabId: TAB,
      started: new Promise<string | null>((done) => (answer = done))
    })
    const { promptDeliveryResult } = launchNewTabPromptThroughHost({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'resolve the conflicts',
      pasteContent: 'resolve the conflicts',
      submit: true
    })

    await vi.advanceTimersByTimeAsync(13_000)
    attachHostPty('split-shell')
    testState.ptyWatchers.get('split-shell')?.('shell drawn\r\n\x1b[?2004h$ ')
    await vi.advanceTimersByTimeAsync(1501)
    testState.appState.ptyIdsByTabId = { [TAB]: ['split-shell', 'launch-agent'] }
    answer('launch-agent')
    await vi.advanceTimersByTimeAsync(10)
    testState.ptyWatchers.get('launch-agent')?.('claude drawn\r\n\x1b[?2004h> ')
    await vi.advanceTimersByTimeAsync(3000)

    await expect(promptDeliveryResult).resolves.toEqual({ delivered: true, failureNotified: false })
    expect(testState.writes.map(({ ptyId, data }) => ({ ptyId, data }))).toEqual([
      { ptyId: 'launch-agent', data: '\x1b[200~resolve the conflicts\x1b[201~' },
      { ptyId: 'launch-agent', data: '\r' }
    ])
  })

  // Regression: with a split bound first, the launch pane's ready bytes were drained to its primary
  // handler before its own watcher attached, so a ready agent never got its prompt.
  it("sees the launch pane's ready output even when a split bound first and it drained at once", async () => {
    let answer!: (startedPtyId: string | null) => void
    testState.launchAgentThroughHost.mockReturnValue({
      tabId: TAB,
      started: new Promise<string | null>((done) => (answer = done))
    })
    const { promptDeliveryResult } = launchNewTabPromptThroughHost({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'task',
      pasteContent: 'task',
      submit: true
    })

    await vi.advanceTimersByTimeAsync(13_000)
    attachHostPty('split-shell')
    bufferPreHandlerPtyData(
      'launch-agent',
      '\x1b[?1049h\x1b[1m›\x1b[0m Implement {feature}\x1b[?2004h'
    )
    // The connect continuation answers, publishes the binding and drains, with no await between.
    answer('launch-agent')
    testState.appState.ptyIdsByTabId = { [TAB]: ['split-shell', 'launch-agent'] }
    for (const subscriber of testState.storeSubscribers) {
      subscriber(testState.appState)
    }
    drainPreHandlerPtyData('launch-agent', vi.fn())
    await vi.advanceTimersByTimeAsync(25_000)

    await expect(promptDeliveryResult).resolves.toEqual({ delivered: true, failureNotified: false })
    expect(new Set(testState.writes.map(({ ptyId }) => ptyId))).toEqual(new Set(['launch-agent']))
    expect(testState.writes.filter(({ data }) => data.includes('task'))).toHaveLength(1)
  })
})
