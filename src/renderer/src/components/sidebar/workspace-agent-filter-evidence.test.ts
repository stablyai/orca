import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import {
  nextFilterAgentIdsForReveal,
  type FilterAgentIds
} from '../../../../shared/workspace-agent-filter'
import {
  collectAgentTypesByWorktree,
  collectWorktreeAgentIds,
  collectWorktreeFilterAgentIds,
  resolveRevealFilterAgentIds,
  worktreeMatchesAgentFilter
} from './workspace-agent-filter-evidence'

const leafId = '11111111-1111-4111-8111-111111111111'

function oneLeafLayout(id = 'leaf-1'): TerminalLayoutSnapshot {
  return { root: { type: 'leaf', leafId: id }, activeLeafId: id, expandedLeafId: null }
}

function splitLayout(first = 'leaf-a', second = 'leaf-b'): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: first },
      second: { type: 'leaf', leafId: second }
    },
    activeLeafId: first,
    expandedLeafId: null
  }
}

describe('collectWorktreeAgentIds', () => {
  it('uses createdWithAgent as last-used agent evidence', () => {
    expect(
      collectWorktreeAgentIds({
        createdWithAgent: 'claude'
      })
    ).toEqual(new Set(['claude']))
  })

  it('keeps Claude Agent Teams distinct from Claude', () => {
    expect(
      collectWorktreeAgentIds({
        createdWithAgent: 'claude-agent-teams'
      })
    ).toEqual(new Set(['claude-agent-teams']))
  })

  it('uses launchAgent on the worktree terminals', () => {
    expect(
      collectWorktreeAgentIds({
        tabs: [{ launchAgent: 'openclaude', title: 'Terminal 1' }]
      })
    ).toEqual(new Set(['openclaude']))
  })

  it('uses title-derived identity when launchAgent is missing', () => {
    expect(
      collectWorktreeAgentIds({
        tabs: [{ title: 'claude [working]' }]
      })
    ).toEqual(new Set(['claude']))
  })

  it('does not treat a Claude mention in a Codex-owned task title as Claude', () => {
    expect(
      collectWorktreeAgentIds({
        tabs: [{ launchAgent: 'codex', title: '⠋ add claude.md' }]
      })
    ).toEqual(new Set(['codex']))
  })

  it('uses a live pane title when the tab title is generic', () => {
    expect(
      collectWorktreeAgentIds({
        tabs: [{ id: 'tab-1', title: 'Terminal 1' }],
        runtimePaneTitlesByTabId: { 'tab-1': { 1: 'codex [working]' } }
      })
    ).toEqual(new Set(['codex']))
  })

  it('uses a split pane title when the tab title is generic', () => {
    expect(
      collectWorktreeAgentIds({
        tabs: [{ id: 'tab-split', title: 'Terminal 1' }],
        runtimePaneTitlesByTabId: {
          'tab-split': { 1: 'codex [working]', 2: 'Terminal 2' }
        }
      })
    ).toEqual(new Set(['codex']))
  })

  it('keeps launch-agent ownership when a single pane has live and parked titles', () => {
    expect(
      collectWorktreeAgentIds({
        tabs: [{ id: 'tab-omp', launchAgent: 'omp', title: 'OMP' }],
        runtimePaneTitlesByTabId: {
          'tab-omp': { 1: '\u280b π: tmp', [-1]: '\u280b π: parked' }
        },
        terminalLayoutsByTabId: { 'tab-omp': oneLeafLayout() }
      })
    ).toEqual(new Set(['omp']))
  })

  it('does not apply launch-agent ownership to parked titles on a split tab', () => {
    expect(
      collectWorktreeAgentIds({
        tabs: [{ id: 'tab-split', launchAgent: 'omp', title: 'Terminal 1' }],
        runtimePaneTitlesByTabId: {
          'tab-split': {
            1: 'codex [working]',
            [-1]: '\u280b π: parked',
            [-2]: 'Terminal 2'
          }
        },
        terminalLayoutsByTabId: { 'tab-split': splitLayout() }
      })
    ).toEqual(new Set(['omp', 'codex', 'pi']))
  })

  it('treats parked-only multi-pane titles as a split', () => {
    expect(
      collectWorktreeAgentIds({
        tabs: [{ id: 'tab-parked', launchAgent: 'omp', title: 'Terminal 1' }],
        runtimePaneTitlesByTabId: {
          'tab-parked': { [-1]: 'codex [working]', [-2]: 'Terminal 2' }
        }
      })
    ).toEqual(new Set(['omp', 'codex']))
  })

  it('unions live/retained/sleeping agent types with created-with and tabs', () => {
    expect(
      collectWorktreeAgentIds({
        createdWithAgent: 'claude',
        tabs: [{ launchAgent: 'codex', title: 'Codex' }],
        extraAgentTypes: ['copilot']
      })
    ).toEqual(new Set(['claude', 'codex', 'copilot']))
  })

  it('drops unknown agent strings so they cannot match a catalog selection', () => {
    expect(
      collectWorktreeAgentIds({
        createdWithAgent: 'unknown',
        extraAgentTypes: ['cc', 'not-an-agent']
      })
    ).toEqual(new Set())
  })
})

describe('worktreeMatchesAgentFilter', () => {
  it('treats a cleared selection as all workspaces', () => {
    expect(
      worktreeMatchesAgentFilter({ id: 'wt-1' }, null, {
        tabsByWorktree: {},
        agentTypesByWorktree: {}
      })
    ).toBe(true)
  })

  it('matches created-with, launch, and extra agent evidence by exact id', () => {
    expect(
      worktreeMatchesAgentFilter({ id: 'wt-cc', createdWithAgent: 'claude' }, ['claude'], {
        tabsByWorktree: {},
        agentTypesByWorktree: {}
      })
    ).toBe(true)
    expect(
      worktreeMatchesAgentFilter(
        { id: 'wt-teams', createdWithAgent: 'claude-agent-teams' },
        ['claude'],
        {
          tabsByWorktree: {},
          agentTypesByWorktree: {}
        }
      )
    ).toBe(false)
    expect(
      worktreeMatchesAgentFilter({ id: 'wt-codex' }, ['codex'], {
        tabsByWorktree: { 'wt-codex': [{ launchAgent: 'codex', title: 'Terminal 1' }] },
        agentTypesByWorktree: {}
      })
    ).toBe(true)
    expect(
      worktreeMatchesAgentFilter({ id: 'wt-split' }, ['codex'], {
        tabsByWorktree: { 'wt-split': [{ id: 'tab-split', title: 'Terminal 1' }] },
        runtimePaneTitlesByTabId: {
          'tab-split': { 1: 'codex [working]', 2: 'Terminal 2' }
        },
        agentTypesByWorktree: {}
      })
    ).toBe(true)
    expect(
      worktreeMatchesAgentFilter({ id: 'wt-omp' }, ['pi'], {
        tabsByWorktree: { 'wt-omp': [{ id: 'tab-omp', launchAgent: 'omp', title: 'OMP' }] },
        runtimePaneTitlesByTabId: {
          'tab-omp': { 1: '\u280b π: tmp', [-1]: '\u280b π: parked' }
        },
        terminalLayoutsByTabId: { 'tab-omp': oneLeafLayout() },
        agentTypesByWorktree: {}
      })
    ).toBe(false)
    expect(
      worktreeMatchesAgentFilter({ id: 'wt-split-parked' }, ['pi'], {
        tabsByWorktree: {
          'wt-split-parked': [{ id: 'tab-split', launchAgent: 'omp', title: 'Terminal 1' }]
        },
        runtimePaneTitlesByTabId: {
          'tab-split': {
            1: 'codex [working]',
            [-1]: '\u280b π: parked',
            [-2]: 'Terminal 2'
          }
        },
        terminalLayoutsByTabId: { 'tab-split': splitLayout() },
        agentTypesByWorktree: {}
      })
    ).toBe(true)
    expect(
      worktreeMatchesAgentFilter({ id: 'wt-live' }, ['openclaude'], {
        tabsByWorktree: {},
        agentTypesByWorktree: { 'wt-live': ['openclaude'] }
      })
    ).toBe(true)
  })

  it('matches a workspace that used any selected agent', () => {
    expect(
      worktreeMatchesAgentFilter(
        { id: 'wt-codex', createdWithAgent: 'codex' },
        ['claude', 'codex'],
        {
          tabsByWorktree: {},
          agentTypesByWorktree: {}
        }
      )
    ).toBe(true)
  })

  it('rejects workspaces with no selected-agent evidence', () => {
    expect(
      worktreeMatchesAgentFilter({ id: 'wt-other', createdWithAgent: 'copilot' }, ['claude'], {
        tabsByWorktree: { 'wt-other': [{ title: 'Terminal 1' }] },
        agentTypesByWorktree: { 'wt-other': ['gemini'] }
      })
    ).toBe(false)
  })
})

describe('collectAgentTypesByWorktree', () => {
  it('indexes live, retained, and sleeping agent records by worktree', () => {
    const paneKey = makePaneKey('tab-live', leafId)
    expect(
      collectAgentTypesByWorktree({
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            worktreeId: 'wt-live',
            agentType: 'claude'
          }
        },
        retainedAgentsByPaneKey: {
          'tab-retained:0': {
            worktreeId: 'wt-retained',
            agentType: 'codex'
          }
        },
        sleepingAgentSessionsByPaneKey: {
          'tab-sleep:0': {
            worktreeId: 'wt-sleep',
            agent: 'claude'
          }
        }
      })
    ).toEqual({
      'wt-live': ['claude'],
      'wt-retained': ['codex'],
      'wt-sleep': ['claude']
    })
  })

  it('falls back to the tab worktree when a live entry omitted worktreeId', () => {
    const paneKey = makePaneKey('tab-1', leafId)
    expect(
      collectAgentTypesByWorktree({
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            agentType: 'codex'
          }
        },
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1' }]
        }
      })
    ).toEqual({
      'wt-1': ['codex']
    })
  })

  it('reveals by adding the hidden workspace agents, or All when evidence is empty', () => {
    const hidden = { id: 'wt-hidden', createdWithAgent: 'codex' as const }
    const empty = { id: 'wt-empty' }
    expect(
      nextFilterAgentIdsForReveal(
        ['claude'],
        collectWorktreeFilterAgentIds(hidden, { tabsByWorktree: {}, agentTypesByWorktree: {} })
      )
    ).toEqual(['claude', 'codex'])
    expect(
      worktreeMatchesAgentFilter(hidden, ['claude'], {
        tabsByWorktree: {},
        agentTypesByWorktree: {}
      })
    ).toBe(false)
    expect(
      nextFilterAgentIdsForReveal(
        ['claude'],
        collectWorktreeFilterAgentIds(empty, { tabsByWorktree: {}, agentTypesByWorktree: {} })
      )
    ).toBeNull()
  })
})

describe('resolveRevealFilterAgentIds', () => {
  const hidden = { id: 'wt-hidden', createdWithAgent: 'codex' as const }
  const empty = { id: 'wt-empty' }
  const alreadyMatching = { id: 'wt-claude', createdWithAgent: 'claude' as const }
  const lookup = { tabsByWorktree: {}, agentTypesByWorktree: {} }

  it('adds the hidden workspace agents when listing still hides it', () => {
    expect(resolveRevealFilterAgentIds(['claude'], hidden, lookup, true)).toEqual([
      'claude',
      'codex'
    ])
  })

  it('clears to All when the hidden workspace has no agent evidence', () => {
    expect(resolveRevealFilterAgentIds(['claude'], empty, lookup, true)).toBeNull()
  })

  it('clears to All when listing hid it but adding agents would be a no-op', () => {
    expect(resolveRevealFilterAgentIds(['claude'], alreadyMatching, lookup, true)).toBeNull()
  })

  it('leaves the selection when the workspace is already visible', () => {
    const current: FilterAgentIds = ['claude']
    expect(resolveRevealFilterAgentIds(current, hidden, lookup, false)).toBe(current)
  })
})

describe('collectAgentTypesByWorktree host isolation', () => {
  it('keys colliding same-id workspaces by host so evidence cannot cross', () => {
    const sharedId = 'repo::/app'
    const paneKey = makePaneKey('tab-local', leafId)
    const extra = collectAgentTypesByWorktree({
      worktrees: [
        { id: sharedId, hostId: 'local' },
        { id: sharedId, hostId: 'ssh:box' }
      ],
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          worktreeId: sharedId,
          agentType: 'claude',
          connectionId: null
        }
      }
    })
    expect(extra).toEqual({ 'local|repo::/app': ['claude'] })
    expect(
      worktreeMatchesAgentFilter({ id: sharedId, hostId: 'local' }, ['claude'], {
        agentTypesByWorktree: extra,
        collidingWorktreeIds: new Set([sharedId])
      })
    ).toBe(true)
    expect(
      worktreeMatchesAgentFilter({ id: sharedId, hostId: 'ssh:box' }, ['claude'], {
        agentTypesByWorktree: extra,
        tabsByWorktree: { [sharedId]: [{ launchAgent: 'claude', title: 'claude [working]' }] },
        collidingWorktreeIds: new Set([sharedId])
      })
    ).toBe(false)
    expect(
      collectWorktreeFilterAgentIds(
        { id: sharedId, hostId: 'ssh:box' },
        {
          agentTypesByWorktree: extra,
          tabsByWorktree: { [sharedId]: [{ launchAgent: 'claude', title: 'claude [working]' }] },
          collidingWorktreeIds: new Set([sharedId])
        }
      )
    ).toEqual(new Set())
  })
})
