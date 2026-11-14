import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RemoteRuntimePtyIdModule from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import type * as LaunchAgentKindModule from '../../../../../../shared/agent-kind'

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

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => testState.appState,
    subscribe: (subscriber: (state: unknown) => void) => {
      testState.storeSubscribers.add(subscriber)
      return () => testState.storeSubscribers.delete(subscriber)
    }
  }
}))
vi.mock('@/lib/agent-session/launch/pane/agent-launch-through-host', () => ({
  launchAgentThroughHost: testState.launchAgentThroughHost
}))
vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: (ptyId: string, watcher: (data: string) => void) => {
    testState.ptyWatchers.set(ptyId, watcher)
    return () => testState.ptyWatchers.delete(ptyId)
  }
}))
vi.mock('@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn(async () => null)
}))
vi.mock(
  '../../../../../../shared/remote-runtime/remote-runtime-pty-id',
  async (importOriginal) => ({
    ...(await importOriginal<typeof RemoteRuntimePtyIdModule>()),
    isRemoteRuntimePtyId: () => false
  })
)
vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: async (ptyId: string, data: string) => {
    testState.writes.push({ at: Date.now(), ...(ptyId === 'pty-1' ? {} : { ptyId }), data })
    return true
  }
}))
vi.mock('@/runtime/hosted-terminals/streams/runtime-terminal-data-subscription', () => ({
  subscribeToRuntimeTerminalData: vi.fn()
}))
vi.mock('../../messaging/paste/agent-ready-wait', () => ({
  waitForAgentReady: vi.fn(async () => ({ ready: false }))
}))
vi.mock('@/diagnostics/telemetry/telemetry', () => ({ track: vi.fn() }))
const mockLaunchAgentKind = vi.hoisted(() => () => 'claude')
vi.mock('../../../../../../shared/agent-kind', async (importOriginal) => ({
  ...(await importOriginal<typeof LaunchAgentKindModule>()),
  tuiAgentToAgentKind: mockLaunchAgentKind
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

const { launchNewTabPromptThroughHost } = await import('./launch-agent-new-tab-host-route')
const { clearPreHandlerPtyState } =
  await import('@/components/terminal-pane/pty-transport/delivery/pty-pre-handler-buffer')

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

  // Attach readiness before host reply so early bracketed-paste signals cannot be lost until timeout.

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

  // A sibling split may bind first; observe launch-pane bytes before its primary handler drains them.

  it('does not paste into a cancelled hosted launch after its composer becomes ready', async () => {
    const { pasteDraftWhenAgentReady } =
      await import('@/lib/agent-session/messaging/paste/agent-paste-draft')
    let cancelled = false
    const delivery = pasteDraftWhenAgentReady({
      tabId: TAB,
      agent: 'codex',
      content: 'cancelled task',
      submit: true,
      forcePaste: true,
      launchPty: Promise.resolve('launch-agent'),
      beforePaste: () => !cancelled
    })
    await vi.advanceTimersByTimeAsync(10)
    cancelled = true
    testState.ptyWatchers.get('launch-agent')?.(
      '\x1b[?1049h\x1b[1m›\x1b[0m Implement {feature}\x1b[?2004h'
    )
    await vi.advanceTimersByTimeAsync(25_000)
    await expect(delivery).resolves.toBe(false)
    expect(testState.writes).toEqual([])
  })
})
