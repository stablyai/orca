import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { retireRemotePtyIncarnation } from './remote-pty-incarnation-replacement'

const { state } = vi.hoisted(() => {
  const agentStatusByPaneKey: Record<string, { terminalHandle?: string }> = {}
  const agentLaunchConfigByPaneKey: Record<string, { identity: { terminalHandle?: string } }> = {}
  return {
    state: {
      agentStatusByPaneKey,
      agentLaunchConfigByPaneKey,
      removeAgentStatus: vi.fn(),
      clearAgentLaunchConfig: vi.fn(),
      clearPaneForegroundAgent: vi.fn()
    }
  }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))

function createSession() {
  return {
    cacheKey: 'pane',
    authoritativeReattachGeneration: 1,
    replayPayloadGeneration: 1,
    clearHiddenOutputRestoreState: vi.fn(),
    clearRestoredSnapshotBaseline: vi.fn(),
    clearPaneMode2031State: vi.fn(),
    kittyKeyboardModes: { reset: vi.fn() },
    paneForegroundAgentTracker: { resetForPtyReplacement: vi.fn() },
    clearCommandInferredPaneAgent: vi.fn(),
    resetPendingShellCommandLine: vi.fn(),
    rememberReattachPayloadAgentSignal: vi.fn(),
    clearStaleAgentTabTitleOnConfirmedShell: vi.fn(),
    deps: { setCacheTimerStartedAt: vi.fn() },
    writeReplayData: vi.fn()
  }
}

describe('remote PTY incarnation replacement publication ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.agentStatusByPaneKey = {}
    state.agentLaunchConfigByPaneKey = {}
  })

  it.each([
    { name: 'known predecessor', rowHandle: 'old', successorHandle: 'new', clear: true },
    {
      name: 'successor published before rebind',
      rowHandle: 'new',
      successorHandle: 'new',
      clear: false
    },
    {
      name: 'same-handle successor publication',
      rowHandle: 'old',
      successorHandle: 'old',
      clear: false
    },
    { name: 'unknown row ownership', rowHandle: undefined, successorHandle: 'new', clear: false }
  ])('only retires a positively owned row: $name', ({ rowHandle, successorHandle, clear }) => {
    const session = createSession()
    state.agentStatusByPaneKey.pane = { terminalHandle: rowHandle }
    state.agentLaunchConfigByPaneKey.pane = { identity: { terminalHandle: rowHandle } }
    retireRemotePtyIncarnation(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies every session member retireRemotePtyIncarnation reads.
      session as unknown as ConnectPanePtySession,
      'remote:env@@old',
      `remote:env@@${successorHandle}`
    )
    expect(state.removeAgentStatus).toHaveBeenCalledTimes(clear ? 1 : 0)
    expect(state.clearAgentLaunchConfig).toHaveBeenCalledTimes(clear ? 1 : 0)
    expect(session.deps.setCacheTimerStartedAt).toHaveBeenCalledTimes(clear ? 1 : 0)
    expect(session.clearStaleAgentTabTitleOnConfirmedShell).not.toHaveBeenCalled()
    expect(session.paneForegroundAgentTracker.resetForPtyReplacement).toHaveBeenCalledOnce()
    expect(session.writeReplayData).toHaveBeenCalledOnce()
  })
})
