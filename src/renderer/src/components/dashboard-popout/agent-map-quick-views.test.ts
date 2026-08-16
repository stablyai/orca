import { describe, expect, it } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { agentMapOrchestrationPaneKeys, filterAgentMapCards } from './agent-map-filter'
import { applyAgentMapQuickView, emptyAgentMapFilterState } from './agent-map-quick-views'

const NOW = 2_000_000_000
const MINUTE = 60_000

function card(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    paneKey: 'pane-1',
    ptyId: null,
    agentType: 'codex',
    bucket: 'working',
    dotState: 'working',
    task: '',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    repoName: 'Orca',
    worktreeName: 'Agent map',
    startedAt: NOW - 60 * MINUTE,
    finishedAt: null,
    stateChangedAt: NOW - 5 * MINUTE,
    statusUpdatedAt: NOW - 5 * MINUTE,
    unseen: false,
    hostKind: 'local',
    ...overrides
  }
}

const TYPES = ['claude', 'codex']

function visible(cards: DashboardCard[], view: Parameters<typeof applyAgentMapQuickView>[0]) {
  const state = applyAgentMapQuickView(view, TYPES)
  return filterAgentMapCards({
    cards,
    enabledStates: state.states,
    enabledHosts: state.hosts,
    enabledAgentTypes: state.agentTypes,
    timeRanges: state.timeRanges,
    orchestrationOnly: state.orchestrationOnly,
    now: NOW
  }).filter((c) => !state.unreadOnly || c.unseen)
}

describe('agent map quick views', () => {
  it('replaces the filters rather than stacking on what was set', () => {
    const stuck = applyAgentMapQuickView('stuck', TYPES)
    const everything = applyAgentMapQuickView('everything', TYPES)

    expect([...stuck.states]).toEqual(['working'])
    expect([...everything.states].sort()).toEqual(['attention', 'done', 'idle', 'working'])
    expect(everything.timeRanges).toEqual(emptyAgentMapFilterState(TYPES).timeRanges)
  })

  it('finds a working agent that has gone quiet, and ignores a chatty one', () => {
    const quiet = card({ paneKey: 'quiet', statusUpdatedAt: NOW - 90 * MINUTE })
    const chatty = card({ paneKey: 'chatty', statusUpdatedAt: NOW - MINUTE })

    expect(visible([quiet, chatty], 'stuck').map((c) => c.paneKey)).toEqual(['quiet'])
  })

  it('keeps only unread agents under the unread view', () => {
    const seen = card({ paneKey: 'seen', unseen: false })
    const unseen = card({ paneKey: 'unseen', unseen: true })

    expect(visible([seen, unseen], 'unread').map((c) => c.paneKey)).toEqual(['unseen'])
  })

  it('shows both ends of an orchestration flow, not just the dispatched child', () => {
    const coordinator = card({ paneKey: 'coordinator' })
    const child = card({ paneKey: 'child', parentPaneKey: 'coordinator' })
    const unrelated = card({ paneKey: 'solo' })

    expect(visible([coordinator, child, unrelated], 'orchestration').map((c) => c.paneKey)).toEqual(
      ['coordinator', 'child']
    )
  })

  it('ignores a parent that is not on the map, so no half-flow is drawn', () => {
    const orphan = card({ paneKey: 'orphan', parentPaneKey: 'coordinator-elsewhere' })

    expect(agentMapOrchestrationPaneKeys([orphan]).size).toBe(0)
    expect(visible([orphan], 'orchestration')).toEqual([])
  })
})
