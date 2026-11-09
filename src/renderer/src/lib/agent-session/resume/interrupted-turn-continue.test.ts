import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state: {
  agentStatusByPaneKey: Record<string, unknown>
  sleepingAgentSessionsByPaneKey: Record<string, unknown>
  tabsByWorktree: Record<string, { id: string }[]>
} = { agentStatusByPaneKey: {}, sleepingAgentSessionsByPaneKey: {}, tabsByWorktree: {} }

vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/hooks/pane-key-pty-id', () => ({ getPtyIdForPaneKey: () => null }))
vi.mock('@/lib/agent-session/messaging/paste/agent-followup-delivery', () => ({
  sendFollowupPromptWhenAgentReady: vi.fn()
}))
vi.mock('@/lib/agent-session/messaging/paste/agent-paste-draft', () => ({
  sendBracketedPasteToRunningAgent: vi.fn()
}))
vi.mock('@/components/terminal-pane/pty-connection/startup/cold-restore-resume-startup', () => ({
  interruptedTurnKey: (entry: { stateStartedAt?: number; updatedAt: number }, paneKey: string) =>
    `${paneKey}|${entry.stateStartedAt ?? entry.updatedAt}`,
  markInterruptedTurnContinued: vi.fn()
}))

const {
  armInterruptedTurnsForHostRestart,
  continueInterruptedTurns,
  disarmInterruptedTurns,
  resetInterruptedTurnContinueForTests
} = await import('./interrupted-turn-continue')

const NOW = 1_800_000_000_000

function working(paneKey: string, agentType: string, over: Record<string, unknown> = {}) {
  return {
    paneKey,
    agentType,
    state: 'working',
    updatedAt: NOW - 5_000,
    stateStartedAt: NOW - 30_000,
    worktreeId: 'ws',
    ...over
  }
}

function deps(over: Partial<Parameters<typeof continueInterruptedTurns>[1]> = {}) {
  let clock = NOW
  const send = vi.fn(async () => true)
  const submit = vi.fn(async () => true)
  return {
    send,
    submit,
    deps: {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms
      },
      ptyIdFor: () => 'pty-1',
      send,
      submit,
      ...over
    }
  }
}

beforeEach(() => {
  resetInterruptedTurnContinueForTests()
  state.agentStatusByPaneKey = {}
  state.sleepingAgentSessionsByPaneKey = {}
  state.tabsByWorktree = { ws: [{ id: 'tab-a' }] }
})
afterEach(() => vi.clearAllMocks())

describe('interrupted turn continue', () => {
  it('continues working Claude and Codex agents once their relaunch is ready', async () => {
    state.agentStatusByPaneKey = {
      'tab-a:1': working('tab-a:1', 'claude'),
      'tab-a:2': working('tab-a:2', 'codex', { worktreeId: undefined, tabId: 'tab-a' })
    }
    expect(armInterruptedTurnsForHostRestart('ws', NOW)).toBe(2)
    const { send, deps: d } = deps()
    expect(await continueInterruptedTurns('ws', d)).toBe(2)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'claude', prompt: 'continue' })
    )
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', prompt: 'continue' })
    )
    // Once per turn: a second settle sends nothing.
    armInterruptedTurnsForHostRestart('ws', NOW)
    expect(await continueInterruptedTurns('ws', d)).toBe(0)
  })

  it('leaves idle, stale, other-workspace and non-resumable agents alone', () => {
    state.tabsByWorktree = { ws: [{ id: 'tab-a' }], other: [{ id: 'tab-b' }] }
    state.agentStatusByPaneKey = {
      idle: working('tab-a:idle', 'claude', { state: 'done' }),
      stale: working('tab-a:stale', 'claude', { updatedAt: NOW - 60 * 60_000 }),
      other: working('tab-b:x', 'claude', { worktreeId: 'other' }),
      shell: working('tab-a:sh', 'unknown')
    }
    expect(armInterruptedTurnsForHostRestart('ws', NOW)).toBe(0)
  })

  it('skips an agent that is already working again after the restart', async () => {
    state.agentStatusByPaneKey = { 'tab-a:1': working('tab-a:1', 'claude') }
    armInterruptedTurnsForHostRestart('ws', NOW)
    state.agentStatusByPaneKey = {
      'tab-a:1': working('tab-a:1', 'claude', {
        stateStartedAt: NOW + 2_000,
        updatedAt: NOW + 2_000
      })
    }
    const { send, deps: d } = deps()
    expect(await continueInterruptedTurns('ws', d)).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('retries until the relaunched agent reads input, then gives up after the wait', async () => {
    state.agentStatusByPaneKey = { 'tab-a:1': working('tab-a:1', 'codex') }
    armInterruptedTurnsForHostRestart('ws', NOW)
    const attempts: number[] = []
    const { deps: d } = deps({
      send: vi.fn(async () => {
        attempts.push(1)
        return attempts.length >= 3
      })
    })
    expect(await continueInterruptedTurns('ws', d)).toBe(1)
    expect(attempts).toHaveLength(3)

    state.agentStatusByPaneKey = {
      'tab-a:2': working('tab-a:2', 'codex', { stateStartedAt: NOW - 1 })
    }
    armInterruptedTurnsForHostRestart('ws', NOW)
    const never = deps({ send: vi.fn(async () => false) })
    expect(await continueInterruptedTurns('ws', never.deps)).toBe(0)
  })

  it('disarm forgets a failed restart', async () => {
    state.agentStatusByPaneKey = { 'tab-a:1': working('tab-a:1', 'claude') }
    armInterruptedTurnsForHostRestart('ws', NOW)
    disarmInterruptedTurns('ws')
    const { send, deps: d } = deps()
    expect(await continueInterruptedTurns('ws', d)).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('relaunched agent already reported', () => {
  it('submits continue directly once the relaunched agent has reported (Codex resumes idle)', async () => {
    resetInterruptedTurnContinueForTests()
    state.agentStatusByPaneKey = { 'tab-a:1': working('tab-a:1', 'codex') }
    armInterruptedTurnsForHostRestart('ws', NOW)
    // After the relaunch the agent reports an interrupted, idle turn.
    state.agentStatusByPaneKey = {
      'tab-a:1': working('tab-a:1', 'codex', {
        state: 'done',
        updatedAt: NOW + 1,
        stateStartedAt: NOW + 1
      })
    }
    const { send, submit, deps: d } = deps()
    expect(await continueInterruptedTurns('ws', d)).toBe(1)
    expect(submit).toHaveBeenCalledWith({ ptyId: 'pty-1', content: 'continue' })
    expect(send).not.toHaveBeenCalled()
  })
})
