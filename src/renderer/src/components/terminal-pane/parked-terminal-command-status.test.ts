import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

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
  agentStatusByPaneKey: Record<string, AgentStatusEntry | undefined>
  runtimePaneTitlesByTabId: Record<string, Record<number, string | undefined>>
  setAgentStatus: ReturnType<typeof vi.fn>
  dropAgentStatus: ReturnType<typeof vi.fn>
  clearAgentLaunchConfig: ReturnType<typeof vi.fn>
}

let mockStoreState: MockStoreState
const dispatchTerminalCommandFinishedEvent = vi.fn()
const resolveLiveAgentStatusConnectionRouting = vi.fn()
const getConnectionIdFromState = vi.fn()

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockStoreState }
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
  return {
    agentStatusByPaneKey: {},
    runtimePaneTitlesByTabId: { [TAB_ID]: { [PANE_ID]: '✳ Build feature' } },
    setAgentStatus: vi.fn(),
    dropAgentStatus: vi.fn(),
    clearAgentLaunchConfig: vi.fn()
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

  it('seeds a Command Code working row with the current pane title', async () => {
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeWorking('Fix the spinner')

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      PANE_KEY,
      { state: 'working', prompt: 'Fix the spinner', agentType: 'command-code' },
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
      { state: 'done', prompt: 'Fix the spinner', agentType: 'command-code' },
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

  // Why: reveal disposes the watcher mid-settle. Flushing would complete the turn early
  // and the same-prompt-done guard then drops the genuine working repaint, so the window
  // transfers to the remounted pane instead — the row stays 'working' across the boundary.
  it('dispose hands the pending settle to the remounted pane instead of completing it early', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const policy = await createPolicy(PTY_ID_LOCAL)
    const { setCommandCodeDoneSettleExecutor } = await import('./command-code-done-settle')

    policy.onCommandCodeDone('Fix the spinner')
    vi.advanceTimersByTime(DONE_SETTLE_MS - 1)
    const revealedPaneSettle = vi.fn()
    setCommandCodeDoneSettleExecutor(PANE_KEY, revealedPaneSettle)
    policy.dispose()

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(revealedPaneSettle).toHaveBeenCalledExactlyOnceWith('Fix the spinner')
  })

  // Why: the transferred window is still a settle window — a working repaint from the
  // revealed pane before the original deadline must cancel it, not race it.
  it('lets a working repaint after the handoff cancel the transferred settle', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const policy = await createPolicy(PTY_ID_LOCAL)
    const { cancelCommandCodeDoneSettle, setCommandCodeDoneSettleExecutor } =
      await import('./command-code-done-settle')

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

  it('nudges git UI on command finished for every PTY class', async () => {
    const local = await createPolicy(PTY_ID_LOCAL)
    local.onCommandFinished(0)
    local.dispose()
    const ssh = await createPolicy(PTY_ID_SSH)
    ssh.onCommandFinished(0)
    ssh.dispose()

    expect(dispatchTerminalCommandFinishedEvent).toHaveBeenCalledTimes(2)
    expect(dispatchTerminalCommandFinishedEvent).toHaveBeenCalledWith(WORKTREE_ID, 0)
  })

  it('drops a same-turn status row on command finished for SSH PTYs only', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry()
    const local = await createPolicy(PTY_ID_LOCAL)
    local.onCommandFinished(0)
    // Why: local drops need the mounted pane's foreground process-confirm ladder
    // (leaked nested-shell 133;D protection), so the watcher must not drop them.
    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
    local.dispose()

    const ssh = await createPolicy(PTY_ID_SSH)
    ssh.onCommandFinished(0)
    expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(PANE_KEY)
    ssh.dispose()
  })

  it('clears the launch registry on SSH command finished when no status row exists', async () => {
    const ssh = await createPolicy(PTY_ID_SSH)

    ssh.onCommandFinished(0)

    expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledWith(PANE_KEY)
    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
    ssh.dispose()
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

describe('readInFlightCommandCodeTurn', () => {
  beforeEach(() => {
    vi.resetModules()
    mockStoreState = makeMockStoreState()
  })

  it('returns only a working command-code turn', async () => {
    const { readInFlightCommandCodeTurn } = await import('./parked-terminal-command-status')

    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    expect(readInFlightCommandCodeTurn(PANE_KEY)).toEqual({ prompt: 'Fix the spinner' })

    // Why 'done' excluded: a stale done row would arm the scrape against whatever
    // process replaced the Command Code TUI.
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
