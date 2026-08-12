import { describe, expect, it } from 'vitest'
import {
  getLiveAgentStatusByWorktreeId,
  getWorktreeIdsWithLiveAgent,
  hasActiveWorkspaceActivity,
  isInactiveWorkspace
} from './worktree-activity-state'
import type { TerminalTab } from '../../../shared/types'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'

const NOW = 10_000_000

function makeTab(id: string): Pick<TerminalTab, 'id'> {
  return { id }
}

function makeAgentEntry(
  overrides: Partial<AgentStatusEntry> & { paneKey: string }
): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: [],
    ...overrides
  }
}

describe('worktree activity state', () => {
  it('treats a slept wake-hint workspace as inactive', () => {
    expect(
      isInactiveWorkspace('wt-1', { 'wt-1': [makeTab('tab-1')] }, { 'tab-1': [] }, {}, new Set())
    ).toBe(true)
  })

  it('treats a never-opened workspace as inactive', () => {
    expect(isInactiveWorkspace('wt-1', {}, {}, {}, new Set())).toBe(true)
  })

  it('treats live terminal workspaces as active', () => {
    const tabsByWorktree = { 'wt-1': [makeTab('tab-1')] }
    const ptyIdsByTabId = { 'tab-1': ['pty-1'] }

    expect(isInactiveWorkspace('wt-1', tabsByWorktree, ptyIdsByTabId, {}, new Set())).toBe(false)
    expect(hasActiveWorkspaceActivity('wt-1', tabsByWorktree, ptyIdsByTabId, {}, new Set())).toBe(
      true
    )
  })

  it('treats browser workspaces as active', () => {
    expect(
      isInactiveWorkspace(
        'wt-1',
        { 'wt-1': [makeTab('tab-1')] },
        { 'tab-1': [] },
        { 'wt-1': [{ id: 'browser-1' }] },
        new Set()
      )
    ).toBe(false)
  })

  it('treats pending paired web host terminal mirrors as inactive without a live pty', () => {
    expect(
      hasActiveWorkspaceActivity(
        'wt-1',
        { 'wt-1': [makeTab('web-terminal-host-tab-1')] },
        {},
        {},
        new Set()
      )
    ).toBe(false)
  })

  it('treats ready paired web host terminal mirrors as active with a live pty', () => {
    expect(
      hasActiveWorkspaceActivity(
        'wt-1',
        { 'wt-1': [makeTab('web-terminal-host-tab-1')] },
        { 'web-terminal-host-tab-1': ['pty-1'] },
        {},
        new Set()
      )
    ).toBe(true)
  })

  it('keeps browser-only workspaces active when mirrored terminals are pending', () => {
    expect(
      hasActiveWorkspaceActivity(
        'wt-1',
        { 'wt-1': [makeTab('web-terminal-host-tab-1')] },
        {},
        { 'wt-1': [{ id: 'browser-1' }] },
        new Set()
      )
    ).toBe(true)
  })

  it('keeps a workspace with a running agent active even without a live pty (#7197)', () => {
    const worktreeIdsWithLiveAgent = new Set(['wt-1'])
    expect(
      hasActiveWorkspaceActivity(
        'wt-1',
        { 'wt-1': [makeTab('tab-1')] },
        { 'tab-1': [] },
        {},
        worktreeIdsWithLiveAgent
      )
    ).toBe(true)
    expect(
      isInactiveWorkspace(
        'wt-1',
        { 'wt-1': [makeTab('tab-1')] },
        { 'tab-1': [] },
        {},
        worktreeIdsWithLiveAgent
      )
    ).toBe(false)
  })

  it('still hides a slept workspace with no live agent entry', () => {
    expect(
      isInactiveWorkspace('wt-1', { 'wt-1': [makeTab('tab-1')] }, { 'tab-1': [] }, {}, new Set())
    ).toBe(true)
  })
})

describe('getWorktreeIdsWithLiveAgent', () => {
  it('returns an empty set when there are no agent entries', () => {
    expect(getWorktreeIdsWithLiveAgent({}, {}, NOW)).toEqual(new Set())
    expect(getWorktreeIdsWithLiveAgent(null, null, NOW)).toEqual(new Set())
  })

  it('attributes an entry by its main-stamped worktreeId', () => {
    const entries = {
      'tab-1:leaf-1': makeAgentEntry({ paneKey: 'tab-1:leaf-1', worktreeId: 'wt-1' })
    }
    expect(getWorktreeIdsWithLiveAgent(entries, {}, NOW)).toEqual(new Set(['wt-1']))
  })

  it('falls back to the paneKey tabId when worktreeId is absent', () => {
    const entries = {
      'tab-1:00000000-0000-4000-8000-000000000000': makeAgentEntry({
        paneKey: 'tab-1:00000000-0000-4000-8000-000000000000'
      })
    }
    expect(getWorktreeIdsWithLiveAgent(entries, { 'wt-1': [makeTab('tab-1')] }, NOW)).toEqual(
      new Set(['wt-1'])
    )
  })

  it('ignores entries that cannot be attributed to any worktree', () => {
    const entries = {
      'orphan:00000000-0000-4000-8000-000000000000': makeAgentEntry({
        paneKey: 'orphan:00000000-0000-4000-8000-000000000000'
      })
    }
    expect(getWorktreeIdsWithLiveAgent(entries, {}, NOW)).toEqual(new Set())
  })

  it('ignores completed headless agents without an open session', () => {
    const entries = {
      'tab-1:leaf-1': makeAgentEntry({
        paneKey: 'tab-1:leaf-1',
        worktreeId: 'wt-1',
        state: 'done'
      })
    }

    expect(getWorktreeIdsWithLiveAgent(entries, {}, NOW)).toEqual(new Set())
  })

  it('ignores stale status left behind after an SSH disconnect', () => {
    const entries = {
      'tab-1:leaf-1': makeAgentEntry({
        paneKey: 'tab-1:leaf-1',
        worktreeId: 'wt-1',
        updatedAt: 0
      })
    }

    expect(getWorktreeIdsWithLiveAgent(entries, {}, NOW)).toEqual(new Set())
  })

  it.each(['working', 'blocked', 'waiting'] as const)(
    'keeps a fresh %s agent visible during a PTY gap',
    (state) => {
      const entries = {
        'tab-1:leaf-1': makeAgentEntry({
          paneKey: 'tab-1:leaf-1',
          worktreeId: 'wt-1',
          state
        })
      }

      expect(getWorktreeIdsWithLiveAgent(entries, {}, NOW)).toEqual(new Set(['wt-1']))
    }
  )

  it('reports working and permission states with permission taking priority', () => {
    const entries = {
      'tab-1:leaf-1': makeAgentEntry({
        paneKey: 'tab-1:leaf-1',
        worktreeId: 'wt-1',
        state: 'working'
      }),
      'tab-2:leaf-2': makeAgentEntry({
        paneKey: 'tab-2:leaf-2',
        worktreeId: 'wt-2',
        state: 'working'
      }),
      'tab-3:leaf-3': makeAgentEntry({
        paneKey: 'tab-3:leaf-3',
        worktreeId: 'wt-2',
        state: 'blocked'
      })
    }

    expect(getLiveAgentStatusByWorktreeId(entries, {}, NOW)).toEqual(
      new Map([
        ['wt-1', 'working'],
        ['wt-2', 'permission']
      ])
    )
  })
})
