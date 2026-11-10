import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state: {
  agentStatusByPaneKey: Record<string, unknown>
  sleepingAgentSessionsByPaneKey: Record<string, unknown>
  tabsByWorktree: Record<string, { id: string }[]>
} = { agentStatusByPaneKey: {}, sleepingAgentSessionsByPaneKey: {}, tabsByWorktree: {} }

vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/hooks/pane-key-pty-id', () => ({ getPtyIdForPaneKey: () => null }))
vi.mock('@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn()
}))
const continued = new Set<string>()
vi.mock('@/lib/agent-session/messaging/paste/agent-followup-delivery', () => ({
  sendFollowupPromptWhenAgentReady: vi.fn()
}))
vi.mock('@/lib/agent-session/messaging/paste/agent-paste-draft', () => ({
  sendBracketedPasteToRunningAgent: vi.fn()
}))
vi.mock('@/components/terminal-pane/pty-connection/startup/cold-restore-resume-startup', () => ({
  interruptedTurnKey: (entry: { stateStartedAt?: number; updatedAt: number }, paneKey: string) =>
    `${paneKey}|${entry.stateStartedAt ?? entry.updatedAt}`,
  markInterruptedTurnContinued: (key: string) => void continued.add(key),
  isInterruptedTurnContinued: (key: string) => continued.has(key)
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
      agentInForeground: async () => true,
      ...over
    }
  }
}

beforeEach(async () => {
  continued.clear()
  const { resetWakeInputForTests } =
    await import('@/components/terminal-pane/input/wake-input-buffer')
  resetWakeInputForTests()
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

  /** The pane opens 10 min after the restart; then the relaunched agent reports `report`. */
  async function lateReopen(report: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    state.agentStatusByPaneKey = {
      'tab-a:1': working('tab-a:1', 'claude', {
        providerSession: { id: 'sess-1' },
        terminalHandle: 'old'
      })
    }
    armInterruptedTurnsForHostRestart('ws', NOW)
    let clock = NOW
    const reopenAt = NOW + 10 * 60_000
    const submit = vi.fn(async (_args: { ptyId: string; content: string }) => true)
    const offer = vi.fn()
    const sent = await continueInterruptedTurns('ws', {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms
        if (clock >= reopenAt + 3_000) {
          state.agentStatusByPaneKey = {
            'tab-a:1': working('tab-a:1', 'claude', {
              updatedAt: reopenAt + 1_000,
              terminalHandle: 'new',
              ...report
            })
          }
        }
      },
      ptyIdFor: () => (clock >= reopenAt ? 'pty-reopened' : null),
      send: vi.fn(async () => false),
      submit,
      agentInForeground: async () => true,
      offer,
      ...extra
    })
    return { sent, submit, offer }
  }

  it('continues a pane reopened long after the restart when the same session came back', async () => {
    const { sent, submit, offer } = await lateReopen({
      providerSession: { id: 'sess-1' },
      state: 'done'
    })
    expect(sent).toBe(1)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]![0]).toMatchObject({ ptyId: 'pty-reopened', content: 'continue' })
    expect(offer).not.toHaveBeenCalled()
  })

  it('offers Continue instead of typing when a late reopen shows a different session', async () => {
    const { sent, submit, offer } = await lateReopen({
      providerSession: { id: 'sess-NEW' },
      state: 'done'
    })
    expect(sent).toBe(0)
    expect(submit).not.toHaveBeenCalled()
    expect(offer).toHaveBeenCalledTimes(1)
  })

  it('offers Continue instead of typing when the person was active in the workspace since', async () => {
    const { noteUserInputForPane } =
      await import('@/components/terminal-pane/input/wake-input-buffer')
    noteUserInputForPane('some-other-pane', NOW + 60_000, 'ws')
    const { sent, submit, offer } = await lateReopen({
      providerSession: { id: 'sess-1' },
      state: 'done'
    })
    expect(sent).toBe(0)
    expect(submit).not.toHaveBeenCalled()
    expect(offer).toHaveBeenCalledTimes(1)
  })

  it('a sleep (disarm) after the restart settled cancels a loop that is already waiting', async () => {
    state.agentStatusByPaneKey = { 'tab-a:1': working('tab-a:1', 'claude') }
    armInterruptedTurnsForHostRestart('ws', NOW)
    let clock = NOW
    const send = vi.fn(async () => true)
    const result = await continueInterruptedTurns('ws', {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms
        if (clock === NOW + 10_000) {
          disarmInterruptedTurns('ws')
        }
      },
      ptyIdFor: () => (clock >= NOW + 60_000 ? 'pty' : null),
      send,
      submit: vi.fn(async () => true),
      agentInForeground: async () => true
    })
    expect(result).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('a re-arm stops the older wait loop, so continue is never sent twice', async () => {
    state.agentStatusByPaneKey = { 'tab-a:1': working('tab-a:1', 'claude') }
    armInterruptedTurnsForHostRestart('ws', NOW)
    let clock = NOW
    const send = vi.fn(async () => true)
    const first = continueInterruptedTurns('ws', {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms
        // A second restart arms the pane again while the first loop is still waiting.
        if (clock === NOW + 5_000) {
          armInterruptedTurnsForHostRestart('ws', clock)
        }
      },
      ptyIdFor: () => (clock >= NOW + 20_000 ? 'pty' : null),
      send,
      submit: vi.fn(async () => true),
      agentInForeground: async () => true
    })
    expect(await first).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('an older loop exiting after a re-arm keeps the newer loop reachable by disarm', async () => {
    state.agentStatusByPaneKey = { 'tab-a:1': working('tab-a:1', 'claude') }
    armInterruptedTurnsForHostRestart('ws', NOW)
    let clock = NOW
    const send = vi.fn(async () => true)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let released = false
    let second: Promise<number> | null = null
    const first = continueInterruptedTurns('ws', {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms
        if (clock === NOW + 5_000) {
          armInterruptedTurnsForHostRestart('ws', clock)
          second = continueInterruptedTurns('ws', {
            now: () => clock,
            sleep: () => gate,
            ptyIdFor: () => (released ? 'pty' : null),
            send,
            submit: vi.fn(async () => true),
            agentInForeground: async () => true
          })
        }
      },
      ptyIdFor: () => null,
      send,
      submit: vi.fn(async () => true),
      agentInForeground: async () => true
    })
    expect(await first).toBe(0)
    // The newer loop is still waiting; a sleep now must cancel it.
    disarmInterruptedTurns('ws')
    released = true
    release()
    expect(second).not.toBeNull()
    expect(await second).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('gives up on a pane that is never reopened while the turn is fresh', async () => {
    state.agentStatusByPaneKey = { 'tab-a:1': working('tab-a:1', 'claude') }
    armInterruptedTurnsForHostRestart('ws', NOW)
    const { send, deps: d } = deps({ ptyIdFor: () => null })
    expect(await continueInterruptedTurns('ws', d)).toBe(0)
    expect(send).not.toHaveBeenCalled()
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

describe('safety', () => {
  function relaunched(over: Record<string, unknown> = {}) {
    return working('tab-a:1', 'codex', {
      state: 'done',
      updatedAt: NOW + 1,
      stateStartedAt: NOW + 1,
      terminalHandle: 'term-new',
      ...over
    })
  }

  it('ignores a report from the terminal that died; accepts one from the relaunched terminal', async () => {
    state.agentStatusByPaneKey = {
      'tab-a:1': working('tab-a:1', 'codex', { terminalHandle: 'term-old' })
    }
    armInterruptedTurnsForHostRestart('ws', NOW)
    state.agentStatusByPaneKey = { 'tab-a:1': relaunched({ terminalHandle: 'term-old' }) }
    const stale = deps({ send: vi.fn(async () => false) })
    expect(await continueInterruptedTurns('ws', stale.deps)).toBe(0)
    expect(stale.submit).not.toHaveBeenCalled()

    state.agentStatusByPaneKey = {
      'tab-a:1': working('tab-a:1', 'codex', {
        terminalHandle: 'term-old',
        stateStartedAt: NOW - 1
      })
    }
    armInterruptedTurnsForHostRestart('ws', NOW)
    state.agentStatusByPaneKey = { 'tab-a:1': relaunched({ stateStartedAt: NOW + 2 }) }
    const fresh = deps()
    expect(await continueInterruptedTurns('ws', fresh.deps)).toBe(1)
    expect(fresh.submit).toHaveBeenCalledTimes(1)
  })

  it('does not paste into a shell: the agent must be the foreground process', async () => {
    state.agentStatusByPaneKey = { 'tab-a:1': working('tab-a:1', 'codex') }
    armInterruptedTurnsForHostRestart('ws', NOW)
    state.agentStatusByPaneKey = { 'tab-a:1': relaunched() }
    const { submit, deps: d } = deps({
      agentInForeground: async () => false,
      send: vi.fn(async () => false)
    })
    expect(await continueInterruptedTurns('ws', d)).toBe(0)
    expect(submit).not.toHaveBeenCalled()
  })

  it('never sends twice when a cold-restore resume already carried continue', async () => {
    state.agentStatusByPaneKey = { 'tab-a:1': working('tab-a:1', 'claude') }
    armInterruptedTurnsForHostRestart('ws', NOW)
    continued.add(`tab-a:1|${NOW - 30_000}`)
    state.agentStatusByPaneKey = { 'tab-a:1': relaunched({ agentType: 'claude' }) }
    const { send, submit, deps: d } = deps()
    expect(await continueInterruptedTurns('ws', d)).toBe(0)
    expect(submit).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('leaves a pane alone once the person typed into it after the restart', async () => {
    const buffer = await import('@/components/terminal-pane/input/wake-input-buffer')
    state.agentStatusByPaneKey = { 'tab-a:1': working('tab-a:1', 'codex') }
    armInterruptedTurnsForHostRestart('ws', NOW)
    let ready = false
    buffer.beginWorkspaceWake('ws', NOW)
    buffer.captureWakeInput(
      'ws',
      '1',
      'hi',
      () => {},
      () => ready
    )
    buffer.pumpWakeInputForTests(NOW + 5)
    ready = true
    buffer.pumpWakeInputForTests(NOW + 10)
    state.agentStatusByPaneKey = { 'tab-a:1': relaunched() }
    const { submit, deps: d } = deps()
    expect(await continueInterruptedTurns('ws', d)).toBe(0)
    expect(submit).not.toHaveBeenCalled()
  })
})

describe('person in charge', () => {
  it('leaves the relaunched agent alone once a person typed into it after the restart', async () => {
    const buffer = await import('@/components/terminal-pane/input/wake-input-buffer')
    state.agentStatusByPaneKey = { 'tab-a:1': working('tab-a:1', 'codex') }
    armInterruptedTurnsForHostRestart('ws', NOW)
    buffer.noteUserInputForPane('1', NOW + 3)
    state.agentStatusByPaneKey = {
      'tab-a:1': working('tab-a:1', 'codex', {
        state: 'done',
        updatedAt: NOW + 1,
        stateStartedAt: NOW + 1
      })
    }
    const { submit, send, deps: d } = deps()
    expect(await continueInterruptedTurns('ws', d)).toBe(0)
    expect(submit).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
