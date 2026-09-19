// Regression guard: a reattach/restore paint goes through writeReplayData, not
// dataCallback, so it must itself mark pane activity — otherwise a remote pane
// whose no-evidence timer is disarmed would never inspect a silently-running
// agent after a restart until that agent's next byte.
import { describe, expect, it, vi } from 'vitest'
import { bindFreshSpawnFollowReset } from './fresh-spawn-follow-reset'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

vi.mock('../replay-guard', () => ({
  replayIntoTerminal: vi.fn(),
  replayIntoTerminalAsync: vi.fn(async () => {})
}))
vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  flushTerminalOutput: vi.fn()
}))

function createSession(): ConnectPanePtySession & {
  agentCompletionCoordinator: { observeOutputActivity: ReturnType<typeof vi.fn> }
} {
  const session = {
    pane: { id: 'pane-1', terminal: {} },
    manager: {},
    deps: {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      replayingPanesRef: { current: new Map() },
      isVisibleRef: { current: true }
    },
    transport: { getPtyId: () => 'ssh:target-1@@pty-1' },
    agentCompletionCoordinator: { observeOutputActivity: vi.fn() },
    shouldRefreshForegroundSynchronously: () => false
  } as unknown as ConnectPanePtySession & {
    agentCompletionCoordinator: { observeOutputActivity: ReturnType<typeof vi.fn> }
  }
  bindFreshSpawnFollowReset(session)
  return session
}

describe('replay paint records pane activity', () => {
  it('marks activity for a sync replay write', () => {
    const session = createSession()
    session.writeReplayData('\x1b[2J$ claude\r\n')
    expect(session.agentCompletionCoordinator.observeOutputActivity).toHaveBeenCalledTimes(1)
  })

  it('marks activity for an async replay write', async () => {
    const session = createSession()
    await session.writeReplayDataAsync('restored frame')
    expect(session.agentCompletionCoordinator.observeOutputActivity).toHaveBeenCalledTimes(1)
  })

  it('ignores an empty write, which paints nothing', async () => {
    const session = createSession()
    session.writeReplayData('')
    await session.writeReplayDataAsync('')
    expect(session.agentCompletionCoordinator.observeOutputActivity).not.toHaveBeenCalled()
  })
})
