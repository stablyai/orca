import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RemoteRuntimePtyIdModule from '../../../shared/remote-runtime/remote-runtime-pty-id'

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
    launchAgentThroughHost: vi.fn(),
    sendGeneratedTerminalInput: vi.fn(async (_ptyId: string, _request: unknown) => 'delivered')
  }
})

// The PTY's host admits and writes the prompt; these cases check which PTY it is handed to.
vi.mock('@/runtime/generated-terminal-input-client', () => ({
  sendGeneratedTerminalInput: testState.sendGeneratedTerminalInput
}))
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
  launchAgentThroughHost: testState.launchAgentThroughHost
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
vi.mock('../../../shared/remote-runtime/remote-runtime-pty-id', async (importOriginal) => ({
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
const { clearPreHandlerPtyState } =
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

  // The host, not this renderer, waits for the composer: nothing is handed over before the pane
  // says its agent started, then exactly once, to that pane's own PTY.
  it('hands the prompt to its own pane once that pane says the agent started', async () => {
    let answer!: (startedPtyId: string | null) => void
    testState.launchAgentThroughHost.mockReturnValue({
      tabId: TAB,
      started: new Promise<string | null>((done) => (answer = done))
    })
    testState.sendGeneratedTerminalInput.mockClear()
    const { promptDeliveryResult } = launchNewTabPromptThroughHost({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'resolve the conflicts',
      pasteContent: 'resolve the conflicts',
      submit: true
    })

    await vi.advanceTimersByTimeAsync(50)
    attachHostPty('pty-1')
    await vi.advanceTimersByTimeAsync(250)
    expect(testState.sendGeneratedTerminalInput).not.toHaveBeenCalled()

    answer('pty-1')
    await vi.advanceTimersByTimeAsync(10)
    expect(testState.sendGeneratedTerminalInput).toHaveBeenCalledExactlyOnceWith(
      'pty-1',
      expect.objectContaining({ text: 'resolve the conflicts', submit: true, intent: 'startup' }),
      // No takeover cancellation: a launch prompt is not held keys. The host keeps a failure notice.
      undefined,
      expect.any(Function),
      expect.any(Function)
    )
    await expect(promptDeliveryResult).resolves.toEqual({ delivered: true, failureNotified: false })
    expect(testState.appState.seedNativeChatLaunchPrompt).toHaveBeenCalledOnce()
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
  it("goes only to its own pane's PTY when another split bound first", async () => {
    let answer!: (startedPtyId: string | null) => void
    testState.launchAgentThroughHost.mockReturnValue({
      tabId: TAB,
      started: new Promise<string | null>((done) => (answer = done))
    })
    testState.sendGeneratedTerminalInput.mockClear()
    const { promptDeliveryResult } = launchNewTabPromptThroughHost({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'resolve the conflicts',
      pasteContent: 'resolve the conflicts',
      submit: true
    })

    await vi.advanceTimersByTimeAsync(13_000)
    attachHostPty('split-shell')
    testState.appState.ptyIdsByTabId = { [TAB]: ['split-shell', 'launch-agent'] }
    answer('launch-agent')
    await vi.advanceTimersByTimeAsync(10)

    await expect(promptDeliveryResult).resolves.toEqual({ delivered: true, failureNotified: false })
    expect(testState.sendGeneratedTerminalInput.mock.calls.map(([ptyId]) => ptyId)).toEqual([
      'launch-agent'
    ])
  })
})
