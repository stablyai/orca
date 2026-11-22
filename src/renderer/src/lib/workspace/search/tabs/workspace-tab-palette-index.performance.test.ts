import { describe, expect, it } from 'vitest'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { createWorkspaceTabPaletteIndex } from './workspace-tab-palette-index'
import type { BuildSearchableWorkspaceTabsOptions } from './workspace-tab-search-types'

// Perf contract (#44777): with the jump palette open, one terminal's title change rebuilt every open tab's
// palette entry in every workspace. Counts label reads on other workspaces' tabs, which must stay 0 at N and 10N.

const TABS_PER_WORKSPACE = 3

function fleet(
  workspaceCount: number,
  onOtherTabRead: () => void
): BuildSearchableWorkspaceTabsOptions {
  const worktrees = Array.from({ length: workspaceCount }, (_, index) =>
    makeWorktree({ id: `wt-${index}`, repoId: 'repo-1', displayName: `Workspace ${index}` })
  )
  const tabsByWorktree: BuildSearchableWorkspaceTabsOptions['tabsByWorktree'] = {}
  const unifiedTabsByWorktree: BuildSearchableWorkspaceTabsOptions['unifiedTabsByWorktree'] = {}
  const groupsByWorktree: BuildSearchableWorkspaceTabsOptions['groupsByWorktree'] = {}
  worktrees.forEach((worktree, workspaceIndex) => {
    const ids = Array.from(
      { length: TABS_PER_WORKSPACE },
      (_, tab) => `term-${workspaceIndex}-${tab}`
    )
    tabsByWorktree[worktree.id] = ids.map((id) =>
      makeTab({ id, worktreeId: worktree.id, title: `Agent ${id}` })
    )
    unifiedTabsByWorktree[worktree.id] = ids.map((id) => {
      const tab = makeUnifiedTab({
        id,
        worktreeId: worktree.id,
        groupId: `group-${worktree.id}`,
        label: ''
      })
      if (workspaceIndex === 0) {
        return tab
      }
      const label = tab.label
      return Object.defineProperty({ ...tab }, 'label', {
        enumerable: true,
        get: () => {
          onOtherTabRead()
          return label
        }
      })
    })
    groupsByWorktree[worktree.id] = [
      makeTabGroup({ id: `group-${worktree.id}`, worktreeId: worktree.id, tabOrder: ids })
    ]
  })
  return {
    worktrees,
    repoMap: new Map([['repo-1', { displayName: 'orca' }]]),
    worktreeOrder: new Map(worktrees.map((worktree, index) => [worktree.id, index])),
    unifiedTabsByWorktree,
    tabsByWorktree,
    openFiles: [],
    agentStatusByPaneKey: acceptedAgentStatuses(),
    sleepingAgentSessionsByPaneKey: {},
    activeGroupIdByWorktree: {},
    groupsByWorktree,
    activeWorktreeId: 'wt-0',
    activeTabType: 'terminal',
    activeTabId: 'term-0-0',
    activeTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {},
    generatedTitlesEnabled: false,
    chatNames: new Map()
  }
}

function otherTabReadsForOneTitleChange(workspaceCount: number) {
  let reads = 0
  const options = fleet(workspaceCount, () => {
    reads += 1
  })
  const index = createWorkspaceTabPaletteIndex()
  index(options)
  const tabs = options.tabsByWorktree['wt-0']!
  const retitled: BuildSearchableWorkspaceTabsOptions = {
    ...options,
    tabsByWorktree: {
      ...options.tabsByWorktree,
      'wt-0': tabs.map((tab, i) => (i === 1 ? { ...tab, title: 'Renamed by agent' } : tab))
    }
  }
  reads = 0
  const entries = index(retitled)
  const readsAfterChange = reads
  expect(entries.find((entry) => entry.tab.id === 'term-0-1')?.title).toBe('Renamed by agent')
  return { readsAfterChange, entries: entries.length }
}

describe('workspace tab palette index: title change scope', () => {
  it('rebuilds only the retitled workspace at N and 10N workspaces', () => {
    expect(otherTabReadsForOneTitleChange(50)).toEqual({
      readsAfterChange: 0,
      entries: 50 * TABS_PER_WORKSPACE
    })
    expect(otherTabReadsForOneTitleChange(500)).toEqual({
      readsAfterChange: 0,
      entries: 500 * TABS_PER_WORKSPACE
    })
  })
})
