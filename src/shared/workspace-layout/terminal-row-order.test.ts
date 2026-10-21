import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../constants'
import type { Tab } from '../tab-types'
import type { TerminalTab } from '../terminal-tab-types'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { orderTerminalRowsByTabGroups } from './terminal-row-order'

const WT = 'repo-1::/Users/dev/orca'

const row = (id: string, sortOrder: number): TerminalTab => ({
  id,
  worktreeId: WT,
  ptyId: null,
  title: id,
  customTitle: null,
  color: null,
  sortOrder,
  createdAt: sortOrder
})

const entry = (id: string, entityId: string, groupId: string): Tab => ({
  id,
  entityId,
  groupId,
  worktreeId: WT,
  contentType: 'terminal',
  label: id,
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
})

function session(rowIds: string[], groupOrders: Record<string, string[]>): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [WT]: rowIds.map(row) },
    unifiedTabs: {
      [WT]: Object.entries(groupOrders).flatMap(([groupId, order]) =>
        order.map((id) => entry(id, `row-${id}`, groupId))
      )
    },
    tabGroups: {
      [WT]: Object.entries(groupOrders).map(([id, tabOrder]) => ({
        id,
        worktreeId: WT,
        activeTabId: tabOrder[0] ?? null,
        tabOrder
      }))
    }
  }
}

const rowIds = (state: WorkspaceSessionState): string[] =>
  state.tabsByWorktree[WT]!.map((tab) => `${tab.id}@${tab.sortOrder}`)

describe('orderTerminalRowsByTabGroups', () => {
  it('orders rows by the tab-bar entries of each group, in group order', () => {
    const before = session(['row-a', 'row-b', 'row-c'], { g1: ['c', 'a'], g2: ['b'] })
    expect(rowIds(orderTerminalRowsByTabGroups(before))).toEqual(['row-c@0', 'row-a@1', 'row-b@2'])
  })

  it('keeps rows no group lists after the grouped ones, in their own order', () => {
    const before = session(['row-x', 'row-a', 'row-y', 'row-b'], { g1: ['b', 'a'] })
    expect(rowIds(orderTerminalRowsByTabGroups(before))).toEqual([
      'row-b@0',
      'row-a@1',
      'row-x@2',
      'row-y@3'
    ])
  })

  it('reads a group listing a row id directly (headless saves)', () => {
    const before: WorkspaceSessionState = {
      ...session(['r1', 'r2'], {}),
      unifiedTabs: {},
      tabGroups: { [WT]: [{ id: 'g', worktreeId: WT, activeTabId: 'r2', tabOrder: ['r2', 'r1'] }] }
    }
    expect(rowIds(orderTerminalRowsByTabGroups(before))).toEqual(['r2@0', 'r1@1'])
  })

  it('returns the same session when the rows already follow the groups', () => {
    const before = session(['row-a', 'row-b'], { g1: ['a', 'b'] })
    expect(orderTerminalRowsByTabGroups(before)).toBe(before)
  })
})
