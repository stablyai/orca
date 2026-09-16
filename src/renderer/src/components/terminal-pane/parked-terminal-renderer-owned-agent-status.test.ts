import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParkedTerminalByteWatcherOptions } from './parked-terminal-byte-watcher'
import type * as ParkedTerminalCommandStatus from './parked-terminal-command-status'

// Owner-encoded remote-runtime id → getRemoteRuntimePtyEnvironmentId resolves 'env-1'.
const REMOTE_PTY_ID = 'remote:env-1@@terminal-1'
const TAB_ID = 'tab-1'
const WORKTREE_ID = 'repo-1::/tmp/wt-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const PANE_ID = 1
const AGENT_STATUS_PAYLOAD = { state: 'working', prompt: 'fix it', agentType: 'codex' } as const

type MockStoreState = {
  settings: {
    theme?: 'system' | 'dark' | 'light'
    terminalMainSideEffectAuthority?: boolean
  } | null
  setRuntimePaneTitle: ReturnType<typeof vi.fn>
  clearRuntimePaneTitle: ReturnType<typeof vi.fn>
  updateTabTitle: ReturnType<typeof vi.fn>
  markWorktreeUnread: ReturnType<typeof vi.fn>
  markTerminalTabUnread: ReturnType<typeof vi.fn>
  markTerminalPaneUnread: ReturnType<typeof vi.fn>
  setCacheTimerStartedAt: ReturnType<typeof vi.fn>
  observeTerminalGitHubPullRequestLink: ReturnType<typeof vi.fn>
  setAgentStatus: ReturnType<typeof vi.fn>
  agentStatusByPaneKey: Record<string, { state: string; prompt: string; agentType?: string }>
}

let mockStoreState: MockStoreState

vi.mock('./use-notification-dispatch', () => ({ dispatchTerminalNotification: vi.fn() }))

const commandStatusPolicy = {
  onCommandFinished: vi.fn(),
  onCommandCodeWorking: vi.fn(),
  onCommandCodeDone: vi.fn(),
  dispose: vi.fn()
}
vi.mock('./parked-terminal-command-status', async (importOriginal) => ({
  ...(await importOriginal<typeof ParkedTerminalCommandStatus>()),
  createParkedTerminalCommandStatusPolicy: vi.fn(() => commandStatusPolicy)
}))

vi.mock('@/lib/terminal-theme', () => ({ getSystemPrefersDark: () => true }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mockStoreState } }))

// Stub routing — these tests cover registry/store wiring, not routing resolution.
const resolveLiveAgentStatusConnectionRouting = vi.fn()
vi.mock('@/lib/agent-status-connection-ownership', () => ({
  resolveLiveAgentStatusConnectionRouting
}))
const getConnectionIdFromState = vi.fn(() => null)
vi.mock('@/lib/connection-owner-resolution', () => ({ getConnectionIdFromState }))

function createMockStoreState(): MockStoreState {
  return {
    settings: { theme: 'system', terminalMainSideEffectAuthority: false },
    setRuntimePaneTitle: vi.fn(),
    clearRuntimePaneTitle: vi.fn(),
    updateTabTitle: vi.fn(),
    markWorktreeUnread: vi.fn(),
    markTerminalTabUnread: vi.fn(),
    markTerminalPaneUnread: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    observeTerminalGitHubPullRequestLink: vi.fn(),
    setAgentStatus: vi.fn(),
    agentStatusByPaneKey: {}
  }
}

// Remote-runtime PTYs bypass main, so the renderer owns agent status across park/reveal.
describe('parked watcher renderer-owned agent status for remote-runtime PTYs', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onData: ((payload: { id: string; data: string }) => void) | null = null

  async function startWatcher(
    overrides: Partial<ParkedTerminalByteWatcherOptions> = {}
  ): Promise<() => void> {
    const { startParkedTerminalByteWatcher } = await import('./parked-terminal-byte-watcher')
    return startParkedTerminalByteWatcher({
      ptyId: REMOTE_PTY_ID,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      leafId: LEAF_ID,
      paneId: PANE_ID,
      ...overrides
    })
  }

  async function dispatchAgentStatus(seq = 1): Promise<void> {
    const handler = await import('./terminal-side-effect-facts-handler')
    handler._dispatchTerminalSideEffectBatchForTest({
      ptyId: REMOTE_PTY_ID,
      seq,
      facts: [{ kind: 'agent-status', payload: { ...AGENT_STATUS_PAYLOAD } }]
    })
  }

  beforeEach(() => {
    vi.resetModules()
    commandStatusPolicy.dispose.mockClear()
    resolveLiveAgentStatusConnectionRouting.mockReset()
    getConnectionIdFromState.mockClear()
    onData = null
    mockStoreState = createMockStoreState()
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        pty: {
          onData: vi.fn((callback: (payload: { id: string; data: string }) => void) => {
            onData = callback
            return () => {}
          }),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {}),
          ackData: vi.fn()
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('registers the claim and proves it on an agent-status fact while parked', async () => {
    const routing = { connectionId: null }
    resolveLiveAgentStatusConnectionRouting.mockReturnValue(routing)
    const registry = await import('./renderer-owned-agent-status-registry')

    // Simulate the mounted pane's claim that survived its dispose (remote-runtime
    // PTYs keep the claim across park/reveal); prove it so hasClientWrite is true.
    const releaseMountedClaim = registry.registerRendererOwnedAgentStatusPane(PANE_KEY, 'env-1')
    registry.markRendererOwnedAgentStatusWrite(PANE_KEY)
    expect(registry.isClientAuthoritativeAgentStatusPane(PANE_KEY)).toBe(true)

    const dispose = await startWatcher()
    // No raw stream for a remote-runtime PTY — the fact channel is the path.
    expect(onData).toBeNull()
    expect(registry._getRendererOwnedAgentStatusPaneCountForTest()).toBe(1)
    // The watcher's re-registration must preserve the mounted pane's hasClientWrite.
    expect(registry.isClientAuthoritativeAgentStatusPane(PANE_KEY)).toBe(true)

    await dispatchAgentStatus()

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      PANE_KEY,
      AGENT_STATUS_PAYLOAD,
      undefined,
      undefined,
      routing
    )
    expect(registry.isClientAuthoritativeAgentStatusPane(PANE_KEY)).toBe(true)
    dispose()
    releaseMountedClaim()
  })

  it('neither writes status nor proves the claim when routing rejects the fact', async () => {
    resolveLiveAgentStatusConnectionRouting.mockReturnValue(undefined)
    const registry = await import('./renderer-owned-agent-status-registry')

    const dispose = await startWatcher()
    await dispatchAgentStatus()

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    // The claim stays registered but unproven, so the host mirror still wins.
    expect(registry._getRendererOwnedAgentStatusPaneCountForTest()).toBe(1)
    expect(registry.isClientAuthoritativeAgentStatusPane(PANE_KEY)).toBe(false)
    dispose()
  })

  it('releases the renderer-owned claim on dispose even without a dispatched fact', async () => {
    resolveLiveAgentStatusConnectionRouting.mockReturnValue({ connectionId: null })
    const registry = await import('./renderer-owned-agent-status-registry')

    const releaseMountedClaim = registry.registerRendererOwnedAgentStatusPane(PANE_KEY, 'env-1')
    registry.markRendererOwnedAgentStatusWrite(PANE_KEY)

    const dispose = await startWatcher()
    expect(registry.isClientAuthoritativeAgentStatusPane(PANE_KEY)).toBe(true)

    // Dispose before any agent-status fact: the release must not be gated on
    // fact handling, or a parked PTY that never produced status would leak.
    dispose()
    expect(registry._getRendererOwnedAgentStatusPaneCountForTest()).toBe(0)
    releaseMountedClaim()
  })

  it('registers no claim for a non-remote parked PTY', async () => {
    const registry = await import('./renderer-owned-agent-status-registry')

    const dispose = await startWatcher({ ptyId: 'pty-local-1' })
    expect(registry._getRendererOwnedAgentStatusPaneCountForTest()).toBe(0)
    dispose()
  })
})
