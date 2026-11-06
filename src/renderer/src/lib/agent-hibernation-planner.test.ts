import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status/contracts/agent-status-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../shared/workspace-layout/terminal-tab-types'
import {
  DEFAULT_AGENT_HIBERNATION_IDLE_MS,
  planAgentHibernationCandidates,
  type AgentHibernationPlannerSnapshot
} from './agent-hibernation-planner'

const NOW = 2_000_000
const OLD = NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 1
const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'

function tab(id = 'tab-1', worktreeId = 'wt-bg'): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function layout(leafId = LEAF, ptyId = 'pty-1'): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  const paneKey = overrides.paneKey ?? `tab-1:${LEAF}`
  return {
    state: 'done',
    prompt: 'make it so',
    updatedAt: OLD,
    stateStartedAt: OLD,
    paneKey,
    tabId: 'tab-1',
    worktreeId: 'wt-bg',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    stateHistory: [],
    ...overrides
  }
}

function snapshot(
  overrides: Partial<AgentHibernationPlannerSnapshot> = {}
): AgentHibernationPlannerSnapshot {
  const agentEntry = entry()
  return {
    settings: {
      experimentalAgentHibernation: true,
      agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS
    },
    activeWorktreeId: 'wt-active',
    foregroundTerminalTabIds: [],
    tabsByWorktree: { 'wt-bg': [tab()] },
    terminalLayoutsByTabId: { 'tab-1': layout() },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    inUsePtyIds: [],
    agentStatusByPaneKey: { [agentEntry.paneKey]: agentEntry },
    sleepingAgentSessionsByPaneKey: {},
    lastTerminalInputAtByPaneKey: {},
    foregroundTerminalLastSeenAtByTabId: {},
    now: NOW,
    ...overrides
  }
}

function plannedWorktrees(input: AgentHibernationPlannerSnapshot): string[] {
  return planAgentHibernationCandidates(input).map((candidate) => candidate.worktreeId)
}

function plannedPaneKeys(input: AgentHibernationPlannerSnapshot): string[] {
  return planAgentHibernationCandidates(input).map((candidate) => candidate.paneKey)
}

describe('agent sleep planner', () => {
  it('selects nothing when disabled or foreground', () => {
    expect(
      plannedWorktrees(
        snapshot({
          settings: {
            experimentalAgentHibernation: false,
            agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS
          }
        })
      )
    ).toEqual([])
    expect(plannedWorktrees(snapshot({ foregroundTerminalTabIds: ['tab-1'] }))).toEqual([])
  })

  it('never plans automatic hibernation for a floating-workspace pane', () => {
    expect(plannedWorktrees(snapshot())).toEqual(['wt-bg'])
    const floating = entry({ worktreeId: FLOATING_TERMINAL_WORKTREE_ID })
    expect(
      plannedWorktrees(
        snapshot({
          tabsByWorktree: {
            [FLOATING_TERMINAL_WORKTREE_ID]: [tab('tab-1', FLOATING_TERMINAL_WORKTREE_ID)]
          },
          agentStatusByPaneKey: { [floating.paneKey]: floating }
        })
      )
    ).toEqual([])
  })

  it('requires done resumable provider-session entries', () => {
    for (const state of ['working', 'waiting', 'blocked'] as const) {
      const e = entry({ state })
      expect(plannedWorktrees(snapshot({ agentStatusByPaneKey: { [e.paneKey]: e } }))).toEqual([])
    }
    const interrupted = entry({ interrupted: true })
    expect(
      plannedWorktrees(snapshot({ agentStatusByPaneKey: { [interrupted.paneKey]: interrupted } }))
    ).toEqual([])
    // A failure ranks like a completion for attention, but a failed pane is never passive.
    const failed = entry({ mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: OLD } })
    expect(
      plannedWorktrees(snapshot({ agentStatusByPaneKey: { [failed.paneKey]: failed } }))
    ).toEqual([])
    // A main agent that finished while its subagents still run is live work, whatever its verdict.
    for (const outcome of ['success', 'failure'] as const) {
      const held = entry({
        state: 'working',
        mainAgent: { state: 'done', outcome, stateStartedAt: OLD }
      })
      expect(
        plannedWorktrees(snapshot({ agentStatusByPaneKey: { [held.paneKey]: held } }))
      ).toEqual([])
    }
    const noSession = entry({ providerSession: undefined })
    expect(
      plannedWorktrees(snapshot({ agentStatusByPaneKey: { [noSession.paneKey]: noSession } }))
    ).toEqual([])
    const ephemeralPi = entry({ agentType: 'pi', providerSession: undefined })
    expect(
      plannedWorktrees(snapshot({ agentStatusByPaneKey: { [ephemeralPi.paneKey]: ephemeralPi } }))
    ).toEqual([])
    const piWithoutTranscript = entry({
      agentType: 'pi',
      providerSession: { key: 'session_id', id: 'pi-session-1' }
    })
    expect(
      plannedWorktrees(
        snapshot({ agentStatusByPaneKey: { [piWithoutTranscript.paneKey]: piWithoutTranscript } })
      )
    ).toEqual([])
    const unsupported = entry({ agentType: 'amp' })
    expect(
      plannedWorktrees(snapshot({ agentStatusByPaneKey: { [unsupported.paneKey]: unsupported } }))
    ).toEqual([])
  })

  it('blocks done panes until their live subagent roster clears', () => {
    const withIdleTeammate = entry({
      subagents: [
        {
          id: 'reviewer-1',
          agentType: 'reviewer',
          state: 'idle',
          startedAt: OLD
        }
      ]
    })
    expect(
      plannedPaneKeys(
        snapshot({ agentStatusByPaneKey: { [withIdleTeammate.paneKey]: withIdleTeammate } })
      )
    ).toEqual([])

    const cleared = { ...withIdleTeammate, subagents: undefined }
    expect(
      plannedPaneKeys(snapshot({ agentStatusByPaneKey: { [cleared.paneKey]: cleared } }))
    ).toEqual([cleared.paneKey])
  })

  it.each([undefined, 'pending', 'dispatched'] as const)(
    'blocks orchestration panes while dispatch status is %s',
    (dispatchStatus) => {
      const orchestrated = entry({
        orchestration: {
          taskId: 'task-1',
          dispatchId: 'ctx-1',
          ...(dispatchStatus ? { dispatchStatus } : {})
        }
      })

      expect(
        plannedPaneKeys(
          snapshot({ agentStatusByPaneKey: { [orchestrated.paneKey]: orchestrated } })
        )
      ).toEqual([])
    }
  )

  it('requires the idle threshold and blocks input after done', () => {
    const fresh = entry({ stateStartedAt: NOW - 1_000, updatedAt: NOW - 1_000 })
    expect(
      plannedWorktrees(snapshot({ agentStatusByPaneKey: { [fresh.paneKey]: fresh } }))
    ).toEqual([])
    expect(
      plannedWorktrees(snapshot({ lastTerminalInputAtByPaneKey: { [`tab-1:${LEAF}`]: OLD + 1 } }))
    ).toEqual([])
    expect(
      plannedWorktrees(snapshot({ lastTerminalInputAtByPaneKey: { [`tab-1:${LEAF}`]: OLD - 1 } }))
    ).toEqual(['wt-bg'])
    // A millisecond tie may be a draft keystroke; block hibernation.
    expect(
      plannedWorktrees(snapshot({ lastTerminalInputAtByPaneKey: { [`tab-1:${LEAF}`]: OLD } }))
    ).toEqual([])
  })

  it('blocks hibernation when real input arrived after the turn started', () => {
    // A draft typed while working precedes done; checking only post-done input would lose it on PTY kill.
    const turnStartedAt = OLD - 60_000
    const withTurn = entry({
      stateHistory: [{ state: 'working', prompt: 'make it so', startedAt: turnStartedAt }]
    })
    expect(
      plannedWorktrees(
        snapshot({
          agentStatusByPaneKey: { [withTurn.paneKey]: withTurn },
          lastTerminalInputAtByPaneKey: { [withTurn.paneKey]: turnStartedAt + 30_000 }
        })
      )
    ).toEqual([])
    // The submission that started the turn precedes the working transition
    // and must not block hibernation.
    expect(
      plannedWorktrees(
        snapshot({
          agentStatusByPaneKey: { [withTurn.paneKey]: withTurn },
          lastTerminalInputAtByPaneKey: { [withTurn.paneKey]: turnStartedAt - 1_000 }
        })
      )
    ).toEqual(['wt-bg'])
    // Input after done still blocks, with or without turn history.
    expect(
      plannedWorktrees(
        snapshot({
          agentStatusByPaneKey: { [withTurn.paneKey]: withTurn },
          lastTerminalInputAtByPaneKey: { [withTurn.paneKey]: OLD + 1 }
        })
      )
    ).toEqual([])
  })

  it('attributes input to its state segment across working/waiting cycles', () => {
    // Inspect all working segments to protect early drafts; waiting-segment permission answers are consumed and must not block.
    const multiSegment = entry({
      stateHistory: [
        { state: 'working', prompt: 'make it so', startedAt: OLD - 90_000 },
        { state: 'waiting', prompt: 'make it so', startedAt: OLD - 60_000 },
        { state: 'working', prompt: 'make it so', startedAt: OLD - 30_000 }
      ]
    })
    expect(
      plannedWorktrees(
        snapshot({
          agentStatusByPaneKey: { [multiSegment.paneKey]: multiSegment },
          lastTerminalInputAtByPaneKey: { [multiSegment.paneKey]: OLD - 75_000 }
        })
      )
    ).toEqual([])
    expect(
      plannedWorktrees(
        snapshot({
          agentStatusByPaneKey: { [multiSegment.paneKey]: multiSegment },
          lastTerminalInputAtByPaneKey: { [multiSegment.paneKey]: OLD - 45_000 }
        })
      )
    ).toEqual(['wt-bg'])
    // Input in a previous done segment was consumed when the next turn started.
    const resubmitted = entry({
      stateHistory: [
        { state: 'done', prompt: 'earlier turn', startedAt: OLD - 90_000 },
        { state: 'working', prompt: 'make it so', startedAt: OLD - 30_000 }
      ]
    })
    expect(
      plannedWorktrees(
        snapshot({
          agentStatusByPaneKey: { [resubmitted.paneKey]: resubmitted },
          lastTerminalInputAtByPaneKey: { [resubmitted.paneKey]: OLD - 45_000 }
        })
      )
    ).toEqual(['wt-bg'])
    // A tie at working or waiting start may belong to a working segment; block conservatively.
    expect(
      plannedWorktrees(
        snapshot({
          agentStatusByPaneKey: { [multiSegment.paneKey]: multiSegment },
          lastTerminalInputAtByPaneKey: { [multiSegment.paneKey]: OLD - 30_000 }
        })
      )
    ).toEqual([])
    expect(
      plannedWorktrees(
        snapshot({
          agentStatusByPaneKey: { [multiSegment.paneKey]: multiSegment },
          lastTerminalInputAtByPaneKey: { [multiSegment.paneKey]: OLD - 60_000 }
        })
      )
    ).toEqual([])
  })

  // Use the active worktree to catch wholesale exclusion (#16211); lever from @sanshengai’s #16214.
  it('does not let one foreground terminal tab reset a sibling tab in the same worktree', () => {
    const siblingEntry = entry({
      paneKey: `tab-2:${OTHER_LEAF}`,
      tabId: 'tab-2',
      providerSession: { key: 'session_id', id: 'session-2' }
    })

    expect(
      plannedPaneKeys(
        snapshot({
          activeWorktreeId: 'wt-bg',
          foregroundTerminalTabIds: ['tab-1'],
          foregroundTerminalLastSeenAtByTabId: {
            'tab-1': NOW
          },
          tabsByWorktree: { 'wt-bg': [tab('tab-1'), tab('tab-2')] },
          terminalLayoutsByTabId: {
            'tab-1': layout(),
            'tab-2': layout(OTHER_LEAF, 'pty-2')
          },
          ptyIdsByTabId: {
            'tab-1': ['pty-1'],
            'tab-2': ['pty-2']
          },
          agentStatusByPaneKey: {
            [`tab-1:${LEAF}`]: entry(),
            [siblingEntry.paneKey]: siblingEntry
          }
        })
      )
    ).toEqual([`tab-2:${OTHER_LEAF}`])
  })

  it('rejects panes without live PTYs and already-sleeping panes', () => {
    expect(plannedWorktrees(snapshot({ ptyIdsByTabId: { 'tab-1': [] } }))).toEqual([])
    expect(
      plannedWorktrees(
        snapshot({
          sleepingAgentSessionsByPaneKey: {
            [`tab-1:${LEAF}`]: {
              paneKey: `tab-1:${LEAF}`,
              tabId: 'tab-1',
              worktreeId: 'wt-bg',
              agent: 'claude',
              providerSession: { key: 'session_id', id: 'session-1' },
              prompt: '',
              state: 'done',
              capturedAt: OLD,
              updatedAt: OLD,
              // A real sleep capture, not this pane's own live anchor.
              origin: 'worktree-sleep'
            } as never
          }
        })
      )
    ).toEqual([])
  })

  it.each([
    {
      agent: 'pi' as const,
      providerSession: {
        key: 'session_id' as const,
        id: 'pi-session-1',
        transcriptPath: '/tmp/pi-session-1.jsonl'
      }
    },
    {
      agent: 'omp' as const,
      providerSession: { key: 'session_id' as const, id: 'omp-session-1' }
    }
  ])(
    'still hibernates completed $agent panes that only retain live resume identity',
    ({ agent, providerSession }) => {
      const agentEntry = entry({ agentType: agent, providerSession })
      expect(
        plannedPaneKeys(
          snapshot({
            agentStatusByPaneKey: { [agentEntry.paneKey]: agentEntry },
            sleepingAgentSessionsByPaneKey: {
              [agentEntry.paneKey]: {
                paneKey: agentEntry.paneKey,
                tabId: 'tab-1',
                worktreeId: 'wt-bg',
                agent,
                providerSession,
                prompt: '',
                state: 'working',
                capturedAt: OLD,
                updatedAt: OLD,
                origin: 'live'
              }
            }
          })
        )
      ).toEqual([agentEntry.paneKey])
    }
  )

  it('does not select layout-only stale PTYs without runtime liveness', () => {
    expect(
      plannedWorktrees(
        snapshot({
          ptyIdsByTabId: { 'tab-1': [] },
          runtimeLivePtyIdsByWorktreeId: { 'wt-bg': [] },
          runtimeLivenessRequiredWorktreeIds: ['wt-bg']
        })
      )
    ).toEqual([])
    expect(
      plannedWorktrees(
        snapshot({
          ptyIdsByTabId: { 'tab-1': ['pty-1'] },
          runtimeLivePtyIdsByWorktreeId: { 'wt-bg': [] },
          runtimeLivenessRequiredWorktreeIds: ['wt-bg']
        })
      )
    ).toEqual([])
    expect(
      plannedWorktrees(
        snapshot({
          ptyIdsByTabId: { 'tab-1': [] },
          runtimeLivenessRequiredWorktreeIds: ['wt-bg']
        })
      )
    ).toEqual([])
  })

  it('applies mobile locks across wrapped remote and raw runtime PTY IDs', () => {
    expect(
      plannedWorktrees(
        snapshot({
          terminalLayoutsByTabId: { 'tab-1': layout(LEAF, 'remote:env-1@@terminal-1') },
          ptyIdsByTabId: { 'tab-1': ['remote:env-1@@terminal-1'] },
          runtimeLivePtyIdsByWorktreeId: { 'wt-bg': ['terminal-1'] },
          runtimeLivenessRequiredWorktreeIds: ['wt-bg'],
          inUsePtyIds: ['remote:env-1@@terminal-1']
        })
      )
    ).toEqual([])
  })

  it("judges another client's view and input on the PTY's own host, though two hosts reuse its id", () => {
    const onB = entry({ paneKey: `tab-b:${LEAF}`, tabId: 'tab-b', worktreeId: 'wt-b' })
    const twoHosts = (attention: { shownRemotely: boolean; lastInputAt: number | null }) =>
      snapshot({
        tabsByWorktree: { 'wt-bg': [tab()], 'wt-b': [tab('tab-b', 'wt-b')] },
        terminalLayoutsByTabId: {
          'tab-1': layout(LEAF, 'remote:env-a@@terminal-1'),
          'tab-b': layout(LEAF, 'remote:env-b@@terminal-1')
        },
        ptyIdsByTabId: {
          'tab-1': ['remote:env-a@@terminal-1'],
          'tab-b': ['remote:env-b@@terminal-1']
        },
        runtimeLivePtyIdsByWorktreeId: { 'wt-bg': ['terminal-1'], 'wt-b': ['terminal-1'] },
        runtimeLivenessRequiredWorktreeIds: ['wt-bg', 'wt-b'],
        agentStatusByPaneKey: { [`tab-1:${LEAF}`]: entry(), [onB.paneKey]: onB },
        attentionByWorktreeId: { 'wt-b': { 'terminal-1': attention } }
      })

    expect(plannedWorktrees(twoHosts({ shownRemotely: true, lastInputAt: null }))).toEqual([
      'wt-bg'
    ])
    expect(plannedWorktrees(twoHosts({ shownRemotely: false, lastInputAt: NOW - 1 }))).toEqual([
      'wt-bg'
    ])
  })
})

describe('idle clock anchors on stateStartedAt, not updatedAt', () => {
  it('keeps the signature stable across such a repaint so confirmation can match', () => {
    const before = entry({ stateStartedAt: OLD, updatedAt: OLD })
    const after = entry({ stateStartedAt: OLD, updatedAt: NOW - 1 })
    const sigFor = (e: AgentStatusEntry): string =>
      planAgentHibernationCandidates(
        snapshot({
          agentStatusByPaneKey: { [e.paneKey]: e },
          ptyBindingFirstSeenAtByPaneKey: { [e.paneKey]: OLD }
        })
      )[0]!.signature
    expect(sigFor(after)).toBe(sigFor(before))
  })

  it('invalidates the signature when agent kind or resume identity changes', () => {
    const base = entry({ stateStartedAt: OLD, updatedAt: OLD })
    const sigFor = (e: AgentStatusEntry): string =>
      planAgentHibernationCandidates(
        snapshot({
          agentStatusByPaneKey: { [e.paneKey]: e },
          ptyBindingFirstSeenAtByPaneKey: { [e.paneKey]: OLD }
        })
      )[0]!.signature
    const baseline = sigFor(base)
    expect(
      sigFor(
        entry({
          stateStartedAt: OLD,
          updatedAt: OLD,
          providerSession: { key: 'session_id', id: 'session-2' }
        })
      )
    ).not.toBe(baseline)
    expect(sigFor(entry({ stateStartedAt: OLD, updatedAt: OLD, agentType: 'codex' }))).not.toBe(
      baseline
    )
    expect(
      sigFor(
        entry({
          stateStartedAt: OLD,
          updatedAt: OLD,
          providerSession: {
            key: 'session_id',
            id: 'session-1',
            transcriptPath: '/tmp/moved.jsonl'
          }
        })
      )
    ).not.toBe(baseline)
  })
})

describe('PTY binding and boundary floors', () => {
  it('defers a pane whose PTY binding was first seen this tick', () => {
    expect(
      plannedPaneKeys(snapshot({ ptyBindingFirstSeenAtByPaneKey: { [`tab-1:${LEAF}`]: NOW } }))
    ).toEqual([])
  })

  it('defers a boundary done that only just became a real completion', () => {
    expect(
      plannedPaneKeys(
        snapshot({
          ptyBindingFirstSeenAtByPaneKey: { [`tab-1:${LEAF}`]: OLD },
          boundaryResolvedAtByPaneKey: { [`tab-1:${LEAF}`]: NOW }
        })
      )
    ).toEqual([])
  })
})
