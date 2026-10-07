import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostAgentLaunchOutcome } from './agent-launch-through-host'

const TAB = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

const testState = vi.hoisted(() => {
  const ptyIdsByTabId: Record<string, string[]> = {}
  const writes: { at: number; data: string }[] = []
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
vi.mock('@/components/terminal-pane/pty-pre-handler-buffer', () => ({
  replayPreHandlerPtyData: vi.fn()
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => false,
  inspectRuntimeTerminalProcess: vi.fn(async () => null),
  sendRuntimePtyInputVerified: async (_settings: unknown, _ptyId: string, data: string) => {
    testState.writes.push({ at: Date.now(), data })
    return true
  }
}))
vi.mock('@/runtime/runtime-terminal-stream', () => ({ subscribeToRuntimeTerminalData: vi.fn() }))
vi.mock('./agent-ready-wait', () => ({ waitForAgentReady: vi.fn(async () => ({ ready: false })) }))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), tuiAgentToAgentKind: () => 'claude' }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

const { launchNewTabPromptThroughHost } = await import('./launch-agent-new-tab-host-route')

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
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // Regression: the paste watched the terminal only after the host's reply, so an agent that had
  // already enabled bracketed paste was never seen ready and its prompt waited out the budget.
  it('is pasted at its own ready signal plus the quiet window, not after the timeout', async () => {
    let answer!: (outcome: HostAgentLaunchOutcome) => void
    testState.launchAgentThroughHost.mockReturnValue({
      tabId: TAB,
      outcome: new Promise<HostAgentLaunchOutcome>((done) => (answer = done))
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

    answer({ kind: 'started' })
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

  it('writes nothing, and seeds no chat copy, when the host says its agent did not start', async () => {
    let answer!: (outcome: HostAgentLaunchOutcome) => void
    testState.launchAgentThroughHost.mockReturnValue({
      tabId: TAB,
      outcome: new Promise<HostAgentLaunchOutcome>((done) => (answer = done))
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
    answer({ kind: 'pane-says' })
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(promptDeliveryResult).resolves.toEqual({ delivered: false, failureNotified: true })
    expect(testState.writes).toEqual([])
    expect(testState.appState.seedNativeChatLaunchPrompt).not.toHaveBeenCalled()
    expect(testState.appState.markNativeChatLaunchPromptFailed).not.toHaveBeenCalled()
  })
})
