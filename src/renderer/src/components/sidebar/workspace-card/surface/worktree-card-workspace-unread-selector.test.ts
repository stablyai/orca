import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { replaceRecordEntries } from '@/store/keyed-record-transitions'
import type * as WorkspaceLiveMarkers from '@/store/slices/workspace-attention/workspace-live-markers'
import type { Worktree } from '../../../../../../shared/worktree/types'
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

const worktree = { id: 'w1', repoId: 'repo', hostId: 'local', isUnread: true } as Worktree
type StatusEntry = AppState['agentStatusByPaneKey'][string]
const entry = (paneKey: string) => ({ paneKey }) as unknown as StatusEntry

function baseState(): AppState {
  return {
    ...useAppStore.getInitialState(),
    tabsByWorktree: {
      w1: [{ id: 'tab1', worktreeId: 'w1' }]
    } as unknown as AppState['tabsByWorktree'],
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
