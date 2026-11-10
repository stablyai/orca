import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentStatusEntry,
  AgentType
} from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { PaneForegroundAgentEntry } from '@/store/slices/agent-status/pane-foreground-agent'

const PTY_ID_LOCAL = 'pty-1'
const PTY_ID_SSH = 'ssh:target-1@@pty-9'
const TAB_ID = 'tab-1'
const WORKTREE_ID = 'repo-1::/tmp/wt-1'
const PANE_KEY = `${TAB_ID}:11111111-1111-4111-8111-111111111111`
const PANE_ID = 1
// Mirrors COMMAND_CODE_OUTPUT_DONE_SETTLE_MS.
const DONE_SETTLE_MS = 1500

const ROUTING = { connectionId: null }

type MockStoreState = {
  tabsByWorktree: Record<string, { id: string; launchAgent?: AgentType }[]>
  agentStatusByPaneKey: Record<string, AgentStatusEntry | undefined>
  retainedAgentsByPaneKey: Record<string, { agentType: AgentType } | undefined>
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry>
  agentLaunchConfigByPaneKey: Record<string, { identity: { agentType?: AgentType } } | undefined>
  runtimePaneTitlesByTabId: Record<string, Record<number, string | undefined>>
  setAgentStatus: ReturnType<typeof vi.fn>
  dropAgentStatus: ReturnType<typeof vi.fn>
  clearAgentLaunchConfig: ReturnType<typeof vi.fn>
  setPaneForegroundAgent: ReturnType<typeof vi.fn>
}

let mockStoreState: MockStoreState
const dispatchTerminalCommandFinishedEvent = vi.fn()
const resolveLiveAgentStatusConnectionRouting = vi.fn()
const getConnectionIdFromState = vi.fn()

vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => mockStoreState }
}))
vi.mock('@/hooks/terminal-command-finished-event', () => ({
  dispatchTerminalCommandFinishedEvent
}))
vi.mock('@/lib/agent-status/ownership/agent-status-connection-ownership', () => ({
  resolveLiveAgentStatusConnectionRouting
}))
vi.mock('@/lib/workspace/ownership/connection-owner-resolution', () => ({
  getConnectionIdFromState
}))

function makeMockStoreState(): MockStoreState {
  return {
    tabsByWorktree: { [WORKTREE_ID]: [{ id: TAB_ID }] },
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    paneForegroundAgentByPaneKey: {},
    agentLaunchConfigByPaneKey: {},
    runtimePaneTitlesByTabId: { [TAB_ID]: { [PANE_ID]: '✳ Build feature' } },
    setAgentStatus: vi.fn(),
    dropAgentStatus: vi.fn(),
    clearAgentLaunchConfig: vi.fn(),
    setPaneForegroundAgent: vi.fn()
  }
}

function makeStatusEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'build the feature',
    agentType: 'claude',
    updatedAt: 1000,
    stateStartedAt: 1000,
    ...overrides
  } as AgentStatusEntry
}

async function createPolicy(ptyId: string) {
  const { createParkedTerminalCommandStatusPolicy } =
    await import('./parked-terminal-command-status')
  return createParkedTerminalCommandStatusPolicy({
    ptyId,
    worktreeId: WORKTREE_ID,
    tabId: TAB_ID,
    paneId: PANE_ID,
    paneKey: PANE_KEY
  })
}

describe('createParkedTerminalCommandStatusPolicy', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    dispatchTerminalCommandFinishedEvent.mockClear()
    resolveLiveAgentStatusConnectionRouting.mockReset().mockReturnValue(ROUTING)
    getConnectionIdFromState.mockReset().mockReturnValue(null)
    mockStoreState = makeMockStoreState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Confirmed parked-agent exit must retire identity; a nested shell’s leaked 133;D must not (#23767).
  describe('parked command boundary with a known foreground agent', () => {
    const confirmForegroundProcess = vi.fn<(id: string) => Promise<string | null>>()
    const flushMicrotasks = async (): Promise<void> => {
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve()
      }
    }

    beforeEach(() => {
      confirmForegroundProcess.mockReset()
      vi.stubGlobal('window', { api: { pty: { confirmForegroundProcess } } })
      mockStoreState.paneForegroundAgentByPaneKey[PANE_KEY] = {
        agent: 'codex',
        shellForeground: false,
        routingTrusted: true
      }
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('writes nothing once the pane was revealed while the confirmation ran', async () => {
      confirmForegroundProcess.mockResolvedValue('zsh')
      const policy = await createPolicy(PTY_ID_LOCAL)

      policy.onCommandFinished(0)
      policy.dispose()
      await flushMicrotasks()

      expect(mockStoreState.setPaneForegroundAgent).not.toHaveBeenCalled()
    })
  })

  it('settles a still-working Command Code row to done after the settle window', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeDone('Fix the spinner')
    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    vi.advanceTimersByTime(DONE_SETTLE_MS)

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      PANE_KEY,
      {
        state: 'done',
        prompt: 'Fix the spinner',
        agentType: 'command-code',
        observation: expect.objectContaining({ origin: 'process', kind: 'transition' })
      },
      '✳ Build feature',
      undefined,
      ROUTING
    )
    policy.dispose()
  })

  it('cancels a pending done settle when a working repaint arrives', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeDone('Fix the spinner')
    policy.onCommandCodeWorking('Fix the spinner')
    vi.advanceTimersByTime(DONE_SETTLE_MS * 2)

    const states = mockStoreState.setAgentStatus.mock.calls.map(([, payload]) => payload.state)
    expect(states).toEqual(['working'])
    policy.dispose()
  })

  // Reveal inherits the settle deadline; flushing early would make the same-prompt guard reject a genuine working repaint.
  it('dispose hands the pending settle to the remounted pane instead of completing it early', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const policy = await createPolicy(PTY_ID_LOCAL)
    const { setCommandCodeDoneSettleExecutor } =
      await import('../../agent-completion/command-code/command-code-done-settle')

    policy.onCommandCodeDone('Fix the spinner')
    vi.advanceTimersByTime(DONE_SETTLE_MS - 1)
    const revealedPaneSettle = vi.fn()
    setCommandCodeDoneSettleExecutor(PANE_KEY, revealedPaneSettle)
    policy.dispose()

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(revealedPaneSettle).toHaveBeenCalledExactlyOnceWith('Fix the spinner')
  })

  // A revealed pane’s working repaint before the inherited deadline must still cancel completion.
  it('lets a working repaint after the handoff cancel the transferred settle', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const policy = await createPolicy(PTY_ID_LOCAL)
    const { cancelCommandCodeDoneSettle, setCommandCodeDoneSettleExecutor } =
      await import('../../agent-completion/command-code/command-code-done-settle')

    policy.onCommandCodeDone('Fix the spinner')
    const revealedPaneSettle = vi.fn()
    setCommandCodeDoneSettleExecutor(PANE_KEY, revealedPaneSettle)
    policy.dispose()
    cancelCommandCodeDoneSettle(PANE_KEY)
    vi.advanceTimersByTime(DONE_SETTLE_MS * 2)

    expect(revealedPaneSettle).not.toHaveBeenCalled()
    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
  })

  it('dispose does not flush a settle a working repaint already cancelled', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeDone('Fix the spinner')
    policy.onCommandCodeWorking('Fix the spinner')
    policy.dispose()

    const states = mockStoreState.setAgentStatus.mock.calls.map(([, payload]) => payload.state)
    expect(states).toEqual(['working'])
  })

  it('dispose after the settle fired writes done exactly once', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeDone('Fix the spinner')
    vi.advanceTimersByTime(DONE_SETTLE_MS)
    policy.dispose()

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledTimes(1)
  })

  it('does nothing after dispose', async () => {
    const ssh = await createPolicy(PTY_ID_SSH)
    ssh.dispose()

    ssh.onCommandFinished(0)
    ssh.onCommandCodeWorking('Fix the spinner')

    expect(dispatchTerminalCommandFinishedEvent).not.toHaveBeenCalled()
    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
  })
})
