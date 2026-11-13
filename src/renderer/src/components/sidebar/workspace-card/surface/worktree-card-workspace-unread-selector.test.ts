import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { replaceRecordEntries } from '@/store/keyed-record-transitions'
import type * as WorkspaceLiveMarkers from '@/store/slices/workspace-attention/workspace-live-markers'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { createWorkspaceUnreadSelector } from './worktree-card-workspace-unread-selector'

const walks = vi.hoisted(() => ({ count: 0 }))
vi.mock('@/store/slices/workspace-attention/workspace-live-markers', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceLiveMarkers>()
  return {
    ...actual,
    workspaceMarkerTabs: (...args: Parameters<typeof actual.workspaceMarkerTabs>) => {
      walks.count += 1
      return actual.workspaceMarkerTabs(...args)
    }
  }
})

const worktree = makeWorktree({ id: 'w1', repoId: 'repo', hostId: 'local', isUnread: true })
type StatusEntry = AppState['agentStatusByPaneKey'][string]
const entry = (paneKey: string): StatusEntry => ({
  paneKey,
  state: 'working',
  prompt: '',
  updatedAt: 1,
  stateStartedAt: 1,
  stateHistory: []
})

function baseState(): AppState {
  return {
    ...useAppStore.getInitialState(),
    tabsByWorktree: {
      w1: [makeTab({ id: 'tab1', worktreeId: 'w1' })]
    },
    agentStatusByPaneKey: {}
  }
}

describe('createWorkspaceUnreadSelector', () => {
  beforeEach(() => {
    walks.count = 0
  })

  it("skips the tab walk for status writes to another workspace's panes", () => {
    const select = createWorkspaceUnreadSelector(worktree, [])
    let state = baseState()
    select(state)
    // The unread resolution walks tabs too; only a skipped evaluation leaves the count alone.
    const settled = walks.count

    state = {
      ...state,
      agentStatusByPaneKey: replaceRecordEntries(state.agentStatusByPaneKey, [
        ['other-tab:leaf', entry('other-tab:leaf')]
      ])
    }
    select(state)
    expect(walks.count).toBe(settled)

    // This workspace's own pane (the terminal tab with no active leaf) re-walks.
    state = {
      ...state,
      agentStatusByPaneKey: replaceRecordEntries(state.agentStatusByPaneKey, [
        ['tab1:', entry('tab1:')]
      ])
    }
    select(state)
    expect(walks.count).toBeGreaterThan(settled)
  })

  it('re-walks after an unannotated status write', () => {
    const select = createWorkspaceUnreadSelector(worktree, [])
    let state = baseState()
    select(state)
    const settled = walks.count
    state = {
      ...state,
      agentStatusByPaneKey: { ...state.agentStatusByPaneKey, other: entry('other') }
    }
    select(state)
    expect(walks.count).toBeGreaterThan(settled)
  })
})
