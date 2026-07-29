import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/types'
import {
  DEFAULT_AGENT_HIBERNATION_IDLE_MS,
  MAX_AGENT_HIBERNATION_IDLE_MS,
  MIN_AGENT_HIBERNATION_IDLE_MS,
  getEffectiveAgentHibernationIdleMs,
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
    mobileLockedPtyIds: [],
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
  it('selects nothing when disabled, active, or foreground', () => {
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
    expect(plannedWorktrees(snapshot({ activeWorktreeId: 'wt-bg' }))).toEqual([])
    expect(plannedWorktrees(snapshot({ foregroundTerminalTabIds: ['tab-1'] }))).toEqual([])
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

  it('requires the idle threshold and blocks input after done', () => {
    const fresh = entry({ updatedAt: NOW - 1_000 })
    expect(
      plannedWorktrees(snapshot({ agentStatusByPaneKey: { [fresh.paneKey]: fresh } }))
    ).toEqual([])
    expect(
      plannedWorktrees(snapshot({ lastTerminalInputAtByPaneKey: { [`tab-1:${LEAF}`]: OLD + 1 } }))
    ).toEqual([])
    expect(
      plannedWorktrees(snapshot({ lastTerminalInputAtByPaneKey: { [`tab-1:${LEAF}`]: OLD - 1 } }))
    ).toEqual(['wt-bg'])
    // A millisecond tie between the input stamp and the done transition
    // resolves toward blocking — the keystroke may be a draft character.
    expect(
      plannedWorktrees(snapshot({ lastTerminalInputAtByPaneKey: { [`tab-1:${LEAF}`]: OLD } }))
    ).toEqual([])
  })

  it('blocks hibernation when real input arrived after the turn started', () => {
    // Regression: a draft typed while the agent was still working lands before
    // the done timestamp, so the old input-after-done compare was blind to it
    // and the hibernation kill discarded the TUI composer's contents.
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
    // A turn can pause for permission (working → waiting → working → done). A
    // draft typed during the FIRST working segment is older than the last
    // working start, so a last-working-start guard misses it; and a permission
    // answer typed during the waiting segment must NOT block, or every session
    // with a mid-turn permission prompt would never hibernate.
    const multiSegment = entry({
      stateHistory: [
        { state: 'working', prompt: 'make it so', startedAt: OLD - 90_000 },
        { state: 'waiting', prompt: 'make it so', startedAt: OLD - 60_000 },
        { state: 'working', prompt: 'make it so', startedAt: OLD - 30_000 }
      ]
    })
    // Draft typed during the first working segment: blocked.
    expect(
      plannedWorktrees(
        snapshot({
          agentStatusByPaneKey: { [multiSegment.paneKey]: multiSegment },
          lastTerminalInputAtByPaneKey: { [multiSegment.paneKey]: OLD - 75_000 }
        })
      )
    ).toEqual([])
    // Permission answer typed during the waiting segment: consumed, eligible.
    expect(
      plannedWorktrees(
        snapshot({
          agentStatusByPaneKey: { [multiSegment.paneKey]: multiSegment },
          lastTerminalInputAtByPaneKey: { [multiSegment.paneKey]: OLD - 45_000 }
        })
      )
    ).toEqual(['wt-bg'])
    // A submission typed in a PREVIOUS done segment that already transitioned
    // onward was consumed and must not block the next completion.
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
    // Boundary ties resolve toward blocking: input stamped exactly at a
    // working-segment start blocks, and a tie at a waiting-segment start also
    // blocks because it could belong to the preceding working segment.
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

  it('uses foreground terminal tab last-seen as the idle baseline when it is newer', () => {
    expect(
      plannedWorktrees(
        snapshot({
          foregroundTerminalLastSeenAtByTabId: {
            'tab-1': NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS + 1
          }
        })
      )
    ).toEqual([])
    expect(
      plannedWorktrees(
        snapshot({
          foregroundTerminalLastSeenAtByTabId: {
            'tab-1': NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 1
          }
        })
      )
    ).toEqual(['wt-bg'])
    expect(
      plannedWorktrees(
        snapshot({
          foregroundTerminalLastSeenAtByTabId: {
            'tab-1': NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 1
          },
          lastTerminalInputAtByPaneKey: { [`tab-1:${LEAF}`]: OLD + 1 }
        })
      )
    ).toEqual([])
  })

  it('does not let one foreground terminal tab reset a sibling tab in the same worktree', () => {
    const siblingEntry = entry({
      paneKey: `tab-2:${OTHER_LEAF}`,
      tabId: 'tab-2',
      providerSession: { key: 'session_id', id: 'session-2' }
    })

    expect(
      plannedPaneKeys(
        snapshot({
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

  it('includes the effective idle start in the candidate signature', () => {
    const oldEntry = entry({
      updatedAt: NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 10_000,
      stateStartedAt: NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 10_000
    })
    const [withoutVisit] = planAgentHibernationCandidates(
      snapshot({ agentStatusByPaneKey: { [oldEntry.paneKey]: oldEntry } })
    )
    const [withVisit] = planAgentHibernationCandidates(
      snapshot({
        agentStatusByPaneKey: { [oldEntry.paneKey]: oldEntry },
        foregroundTerminalLastSeenAtByTabId: {
          'tab-1': NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 1
        }
      })
    )

    expect(withoutVisit.signature).not.toEqual(withVisit.signature)
  })

  it('emits a pane candidate when a sibling shell PTY is live', () => {
    expect(
      planAgentHibernationCandidates(
        snapshot({ ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-shell'] } })
      )
    ).toMatchObject([
      {
        id: `wt-bg|tab-1:${LEAF}`,
        worktreeId: 'wt-bg',
        paneKey: `tab-1:${LEAF}`,
        tabId: 'tab-1',
        leafId: LEAF,
        targetPtyIds: ['pty-1'],
        expectedRuntimePtyIds: ['pty-1'],
        paneKeys: [`tab-1:${LEAF}`]
      }
    ])
  })

  it('rejects panes without live PTYs and already-sleeping panes', () => {
    expect(plannedWorktrees(snapshot({ ptyIdsByTabId: { 'tab-1': [] } }))).toEqual([])
    expect(
      plannedWorktrees(
        snapshot({ sleepingAgentSessionsByPaneKey: { [`tab-1:${LEAF}`]: {} as never } })
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

  it('rejects mobile-driven panes because paired clients can send input outside desktop xterm', () => {
    expect(plannedWorktrees(snapshot({ mobileLockedPtyIds: ['pty-1'] }))).toEqual([])
  })

  it('does not let a mobile-locked sibling PTY block an unlocked target pane', () => {
    expect(
      plannedPaneKeys(
        snapshot({
          ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-shell'] },
          mobileLockedPtyIds: ['pty-shell']
        })
      )
    ).toEqual([`tab-1:${LEAF}`])
  })

  it('selects runtime-backed live PTYs when the renderer live map is empty', () => {
    const [candidate] = planAgentHibernationCandidates(
      snapshot({
        ptyIdsByTabId: { 'tab-1': [] },
        runtimeLivePtyIdsByWorktreeId: { 'wt-bg': ['pty-1'] },
        runtimeLivenessRequiredWorktreeIds: ['wt-bg']
      })
    )

    expect(candidate).toMatchObject({
      worktreeId: 'wt-bg',
      paneKeys: [`tab-1:${LEAF}`],
      expectedRuntimePtyIds: ['pty-1']
    })
  })

  it('matches wrapped remote renderer PTY IDs to raw runtime PTY IDs', () => {
    const [candidate] = planAgentHibernationCandidates(
      snapshot({
        terminalLayoutsByTabId: { 'tab-1': layout(LEAF, 'remote:env-1@@terminal-1') },
        ptyIdsByTabId: { 'tab-1': ['remote:env-1@@terminal-1'] },
        runtimeLivePtyIdsByWorktreeId: { 'wt-bg': ['terminal-1'] },
        runtimeLivenessRequiredWorktreeIds: ['wt-bg']
      })
    )

    expect(candidate).toMatchObject({
      worktreeId: 'wt-bg',
      paneKeys: [`tab-1:${LEAF}`],
      expectedRuntimePtyIds: ['terminal-1']
    })
  })

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

  it('allows runtime-backed worktrees with sibling live PTYs', () => {
    expect(
      plannedPaneKeys(
        snapshot({
          ptyIdsByTabId: { 'tab-1': [] },
          runtimeLivePtyIdsByWorktreeId: { 'wt-bg': ['pty-1', 'pty-shell'] },
          runtimeLivenessRequiredWorktreeIds: ['wt-bg']
        })
      )
    ).toEqual([`tab-1:${LEAF}`])
  })

  it('applies mobile locks to runtime-backed PTYs', () => {
    expect(
      plannedWorktrees(
        snapshot({
          ptyIdsByTabId: { 'tab-1': [] },
          runtimeLivePtyIdsByWorktreeId: { 'wt-bg': ['pty-1'] },
          runtimeLivenessRequiredWorktreeIds: ['wt-bg'],
          mobileLockedPtyIds: ['pty-1']
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
          mobileLockedPtyIds: ['remote:env-1@@terminal-1']
        })
      )
    ).toEqual([])
  })

  it('selects each eligible done agent pane independently', () => {
    expect(plannedWorktrees(snapshot())).toEqual(['wt-bg'])
    const second = entry({
      paneKey: `tab-1:${OTHER_LEAF}`,
      providerSession: { key: 'session_id', id: 'session-2' }
    })
    expect(
      plannedPaneKeys(
        snapshot({
          terminalLayoutsByTabId: {
            'tab-1': {
              root: {
                type: 'split',
                direction: 'horizontal',
                first: { type: 'leaf', leafId: LEAF },
                second: { type: 'leaf', leafId: OTHER_LEAF }
              },
              activeLeafId: LEAF,
              expandedLeafId: null,
              ptyIdsByLeafId: { [LEAF]: 'pty-1', [OTHER_LEAF]: 'pty-2' }
            }
          },
          ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-2'] },
          agentStatusByPaneKey: { [`tab-1:${LEAF}`]: entry(), [second.paneKey]: second }
        })
      )
    ).toEqual([`tab-1:${LEAF}`, `tab-1:${OTHER_LEAF}`])
  })

  it('clamps corrupt or out-of-range idle durations to the default', () => {
    expect(getEffectiveAgentHibernationIdleMs(0)).toBe(DEFAULT_AGENT_HIBERNATION_IDLE_MS)
    expect(getEffectiveAgentHibernationIdleMs(Number.NaN)).toBe(DEFAULT_AGENT_HIBERNATION_IDLE_MS)
    expect(getEffectiveAgentHibernationIdleMs(MIN_AGENT_HIBERNATION_IDLE_MS - 1)).toBe(
      DEFAULT_AGENT_HIBERNATION_IDLE_MS
    )
    expect(getEffectiveAgentHibernationIdleMs(MAX_AGENT_HIBERNATION_IDLE_MS + 1)).toBe(
      DEFAULT_AGENT_HIBERNATION_IDLE_MS
    )
    expect(getEffectiveAgentHibernationIdleMs(MIN_AGENT_HIBERNATION_IDLE_MS)).toBe(
      MIN_AGENT_HIBERNATION_IDLE_MS
    )
    expect(getEffectiveAgentHibernationIdleMs(DEFAULT_AGENT_HIBERNATION_IDLE_MS + 1)).toBe(
      DEFAULT_AGENT_HIBERNATION_IDLE_MS + 1
    )
  })
})
