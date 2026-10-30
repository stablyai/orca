import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'

const PTY_ID_LOCAL = 'pty-1'
const TAB_ID = 'tab-1'
const WORKTREE_ID = 'repo-1::/tmp/wt-1'
const PANE_KEY = `${TAB_ID}:11111111-1111-4111-8111-111111111111`
const PANE_ID = 1
// Mirrors COMMAND_CODE_OUTPUT_DONE_SETTLE_MS.
const DONE_SETTLE_MS = 1500

const ROUTING = { connectionId: null }

type MockStoreState = {
  settings: { promptCacheTimerEnabled: boolean }
  tabsByWorktree: Record<string, { id: string; launchAgent?: AgentType }[]>
  agentStatusByPaneKey: Record<string, AgentStatusEntry | undefined>
  retainedAgentsByPaneKey: Record<string, { agentType: AgentType } | undefined>
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry>
  agentLaunchConfigByPaneKey: Record<string, { identity: { agentType?: AgentType } } | undefined>
  runtimePaneTitlesByTabId: Record<string, Record<number, string | undefined>>
  setCacheTimerStartedAt: ReturnType<typeof vi.fn>
  setAgentStatus: ReturnType<typeof vi.fn>
  dropAgentStatus: ReturnType<typeof vi.fn>
  clearAgentLaunchConfig: ReturnType<typeof vi.fn>
  setPaneForegroundAgent: ReturnType<typeof vi.fn>
}

let mockStoreState: MockStoreState
const dispatchTerminalCommandFinishedEvent = vi.fn()
const resolveLiveAgentStatusConnectionRouting = vi.fn()
const getConnectionIdFromState = vi.fn()

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockStoreState, subscribe: vi.fn(() => () => {}) }
}))
vi.mock('@/hooks/terminal-command-finished-event', () => ({
  dispatchTerminalCommandFinishedEvent
}))
vi.mock('@/lib/agent-status-connection-ownership', () => ({
  resolveLiveAgentStatusConnectionRouting
}))
vi.mock('@/lib/connection-owner-resolution', () => ({
  getConnectionIdFromState
}))

function makeMockStoreState(): MockStoreState {
  const initialStore: ReturnType<typeof createInitialStoreState> = createInitialStoreState(
    () => initialStore
  )
  return {
    ...initialStore,
    settings: { promptCacheTimerEnabled: true },
    tabsByWorktree: { [WORKTREE_ID]: [{ id: TAB_ID }] },
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    paneForegroundAgentByPaneKey: {},
    agentLaunchConfigByPaneKey: {},
    runtimePaneTitlesByTabId: { [TAB_ID]: { [PANE_ID]: '✳ Build feature' } },
    setAgentStatus: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
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
  const { createTerminalResidentPolicy } = await import('./terminal-resident-policy')
  const policy = createTerminalResidentPolicy(
    {
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      paneKey: PANE_KEY,
      cwd: '',
      initialTitle: mockStoreState.runtimePaneTitlesByTabId[TAB_ID]?.[PANE_ID]
    },
    { endpoint: 'local', executionHost: 'local', ptyId, runtimeId: null, incarnationId: null },
    () => true
  )
  return { ...policy.commandCode, dispose: () => policy.dispose() }
}

async function createPresentedExecution(incarnationId = 'command-code-execution') {
  const {
    admitLegacyTerminalSemanticResident,
    getTerminalSemanticResident,
    retireTerminalSemanticResident
  } = await import('./terminal-side-effect-facts-handler')
  const resident = admitLegacyTerminalSemanticResident({
    ptyId: PTY_ID_LOCAL,
    incarnationId,
    byteSource: false,
    binding: {
      paneKey: PANE_KEY,
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      cwd: '',
      initialTitle: mockStoreState.runtimePaneTitlesByTabId[TAB_ID]?.[PANE_ID]
    }
  })
  const policy = resident.policy
  return {
    resident,
    policy,
    current: () => getTerminalSemanticResident(PTY_ID_LOCAL),
    attach: () =>
      policy.attachPresentation({
        paneId: PANE_ID,
        isVisible: () => true,
        showTitle: vi.fn(),
        resetInputModes: vi.fn(),
        setFocusReportSuppression: vi.fn(),
        markBracketedPasteInterrupted: vi.fn(),
        onAgentExited: vi.fn(),
        setMode2031: vi.fn(),
        clearFocusReportSuppression: vi.fn()
      }),
    retire: () =>
      retireTerminalSemanticResident(PTY_ID_LOCAL, resident.identity.incarnationId ?? undefined)
  }
}

describe('terminal Command Code status policy', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    dispatchTerminalCommandFinishedEvent.mockClear()
    resolveLiveAgentStatusConnectionRouting.mockReset().mockReturnValue(ROUTING)
    getConnectionIdFromState.mockReset().mockReturnValue(null)
    mockStoreState = makeMockStoreState()
    vi.stubGlobal('window', {
      api: {
        pty: {
          inspectProcess: vi
            .fn()
            .mockResolvedValue({ foregroundProcess: null, hasChildProcesses: false })
        }
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('seeds a Command Code working row with the current pane title', async () => {
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeWorking('Fix the spinner')

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      PANE_KEY,
      {
        state: 'working',
        prompt: 'Fix the spinner',
        agentType: 'command-code',
        // Why: the row is read off the pane's own output, not a provider signal (STA-4293).
        observation: expect.objectContaining({ origin: 'process', kind: 'transition' })
      },
      '✳ Build feature',
      undefined,
      ROUTING
    )
    policy.dispose()
  })

  it('writes nothing when connection routing does not resolve', async () => {
    resolveLiveAgentStatusConnectionRouting.mockReturnValue(undefined)
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeWorking('Fix the spinner')

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    policy.dispose()
  })

  it('rejects scrape status when a Claude hook owns the pane', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({ state: 'done' })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeWorking('False prompt')
    policy.onCommandCodeDone('False prompt')
    vi.advanceTimersByTime(DONE_SETTLE_MS)

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    policy.dispose()
  })

  it('rejects scrape status when retained Claude identity owns the pane', async () => {
    mockStoreState.retainedAgentsByPaneKey[PANE_KEY] = { agentType: 'claude' }
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({ agentType: 'unknown' })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeWorking('False prompt')
    policy.onCommandCodeDone('False prompt')
    vi.advanceTimersByTime(DONE_SETTLE_MS)

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    policy.dispose()
  })

  it('rejects scrape status when Claude launch metadata owns the pane', async () => {
    mockStoreState.tabsByWorktree[WORKTREE_ID] = [{ id: TAB_ID, launchAgent: 'claude' }]
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeWorking('False prompt')

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    policy.dispose()
  })

  it('rejects scrape status when Claude is the foreground process', async () => {
    mockStoreState.paneForegroundAgentByPaneKey[PANE_KEY] = {
      agent: 'claude',
      shellForeground: false
    }
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeWorking('False prompt')

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    policy.dispose()
  })

  it('lets a current Command Code process reclaim stale Claude ownership', async () => {
    mockStoreState.tabsByWorktree[WORKTREE_ID] = [{ id: TAB_ID, launchAgent: 'claude' }]
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({ state: 'done' })
    mockStoreState.retainedAgentsByPaneKey[PANE_KEY] = { agentType: 'claude' }
    mockStoreState.paneForegroundAgentByPaneKey[PANE_KEY] = {
      agent: 'command-code',
      shellForeground: false
    }
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeWorking('New Command Code prompt')

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      PANE_KEY,
      {
        state: 'working',
        prompt: 'New Command Code prompt',
        agentType: 'command-code',
        observation: expect.objectContaining({ origin: 'process', kind: 'transition' })
      },
      '✳ Build feature',
      undefined,
      ROUTING
    )
    policy.dispose()
  })

  it('leaves a settled done row alone when working repeats the same prompt', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'done',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeWorking('Fix the spinner')
    policy.onCommandCodeWorking('')

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    policy.dispose()
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

  it('abandons the done settle when another agent owns the row by then', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({ agentType: 'claude' })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeDone('Fix the spinner')
    vi.advanceTimersByTime(DONE_SETTLE_MS)

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
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

  it('retains the admitted execution, policy and deadline across presentation detach and reveal', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const execution = await createPresentedExecution()
    const { resident, policy } = execution
    const commandCode = policy.commandCode
    let detach = execution.attach()
    try {
      commandCode.onCommandCodeDone('Fix the spinner')
      const pendingTimers = vi.getTimerCount()
      vi.advanceTimersByTime(DONE_SETTLE_MS - 1)
      detach()
      expect(resident.isLive).toBe(true)
      expect(execution.current()).toBe(resident)
      detach = execution.attach()
      expect(resident.policy).toBe(policy)
      expect(resident.policy.commandCode).toBe(commandCode)
      expect(vi.getTimerCount()).toBe(pendingTimers)
      expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(mockStoreState.setAgentStatus).toHaveBeenCalledExactlyOnceWith(
        PANE_KEY,
        expect.objectContaining({
          state: 'done',
          prompt: 'Fix the spinner',
          agentType: 'command-code'
        }),
        expect.anything(),
        undefined,
        ROUTING
      )
      vi.advanceTimersByTime(DONE_SETTLE_MS)
      expect(mockStoreState.setAgentStatus).toHaveBeenCalledTimes(1)
    } finally {
      detach()
      execution.retire()
    }
  })

  it('lets a working repaint after presentation reveal cancel the same execution settle', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const execution = await createPresentedExecution()
    const { policy, resident } = execution
    let detach = execution.attach()
    try {
      policy.commandCode.onCommandCodeDone('Fix the spinner')
      vi.advanceTimersByTime(DONE_SETTLE_MS - 1)
      detach()
      detach = execution.attach()
      expect(execution.current()).toBe(resident)
      policy.commandCode.onCommandCodeWorking('Fix the spinner')
      vi.advanceTimersByTime(DONE_SETTLE_MS * 2)
      expect(mockStoreState.setAgentStatus).toHaveBeenCalledExactlyOnceWith(
        PANE_KEY,
        expect.objectContaining({
          state: 'working',
          prompt: 'Fix the spinner',
          agentType: 'command-code'
        }),
        expect.anything(),
        undefined,
        ROUTING
      )
    } finally {
      detach()
      execution.retire()
    }
  })

  it('releases a pending Done timer and executor when its admitted execution ends', async () => {
    const working = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = working
    const execution = await createPresentedExecution()
    const detach = execution.attach()
    const ended = vi.fn()
    execution.resident.onEnd(ended)
    try {
      const timersBeforeSettle = vi.getTimerCount()
      execution.policy.commandCode.onCommandCodeDone(working.prompt)
      expect(vi.getTimerCount()).toBe(timersBeforeSettle + 1)
      vi.advanceTimersByTime(DONE_SETTLE_MS - 1)
      expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
      expect(execution.current()).toBe(execution.resident)
      expect(execution.resident.isLive).toBe(true)

      execution.retire()
      expect(execution.resident.isLive).toBe(false)
      expect(execution.policy.isLive()).toBe(false)
      expect(execution.current()).toBeUndefined()
      expect(ended).toHaveBeenCalledExactlyOnceWith(execution.resident)
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(DONE_SETTLE_MS + 1)
      expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
      expect(mockStoreState.agentStatusByPaneKey[PANE_KEY]).toBe(working)
      expect(vi.getTimerCount()).toBe(0)

      // A matching row and unqualified public deadline would expose a retained executor.
      const { openCommandCodeDoneSettle } = await import('./command-code-done-settle')
      openCommandCodeDoneSettle(PANE_KEY, working.prompt)
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(DONE_SETTLE_MS)
      expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)

      const successor = await createPresentedExecution('command-code-successor')
      const nextWorking = makeStatusEntry({
        state: 'working',
        prompt: 'Fix the next spinner',
        agentType: 'command-code',
        updatedAt: 1001
      })
      mockStoreState.agentStatusByPaneKey[PANE_KEY] = nextWorking
      try {
        expect(successor.resident).not.toBe(execution.resident)
        execution.retire()
        expect(successor.current()).toBe(successor.resident)
        expect(successor.resident.isLive).toBe(true)
        successor.policy.commandCode.onCommandCodeDone(nextWorking.prompt)
        vi.advanceTimersByTime(DONE_SETTLE_MS - 1)
        expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(mockStoreState.setAgentStatus).toHaveBeenCalledExactlyOnceWith(
          PANE_KEY,
          expect.objectContaining({
            state: 'done',
            prompt: nextWorking.prompt,
            agentType: 'command-code'
          }),
          expect.anything(),
          undefined,
          ROUTING
        )
        expect(ended).toHaveBeenCalledTimes(1)
      } finally {
        successor.retire()
      }
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      detach()
      execution.retire()
    }
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

  it('dispose does not flush when another agent owns the row by then', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({ agentType: 'claude' })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeDone('Fix the spinner')
    policy.dispose()

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
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
})

describe('readInFlightCommandCodeTurn', () => {
  beforeEach(() => {
    vi.resetModules()
    mockStoreState = makeMockStoreState()
    vi.stubGlobal('window', {
      api: {
        pty: {
          inspectProcess: vi
            .fn()
            .mockResolvedValue({ foregroundProcess: null, hasChildProcesses: false })
        }
      }
    })
  })

  it('returns only a working command-code turn', async () => {
    const { readInFlightCommandCodeTurn } = await import('./terminal-command-code-status-policy')

    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    expect(readInFlightCommandCodeTurn(PANE_KEY)).toEqual({ prompt: 'Fix the spinner' })

    // Done rows cannot seed a live detector: a replacement process could be scraped as Command Code.
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'done',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    expect(readInFlightCommandCodeTurn(PANE_KEY)).toBeNull()

    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({ agentType: 'claude' })
    expect(readInFlightCommandCodeTurn(PANE_KEY)).toBeNull()

    delete mockStoreState.agentStatusByPaneKey[PANE_KEY]
    expect(readInFlightCommandCodeTurn(PANE_KEY)).toBeNull()
  })
})
