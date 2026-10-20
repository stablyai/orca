import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { WorktreeSplitViewPair } from '../../../../shared/worktree-split-view-pair'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { buildWorkspaceSessionPatch } from '@/lib/workspace-session-patch'
import { createTestStore, makeLayout, makeTab, makeWorktree } from './store-test-helpers'
import { createStoreSessionMockApi } from './store-session-test-harness'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

const WT_A = 'repo1::/path/a'
const WT_B = 'repo1::/path/b'
const PAIR: WorktreeSplitViewPair = {
  leftWorktreeId: WT_A,
  leftExecutionHostId: null,
  rightWorktreeId: WT_B,
  rightExecutionHostId: null
}

function storeWithWorktrees(ids: string[]) {
  const store = createTestStore()
  store.setState({
    repos: [{ id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }],
    worktreesByRepo: {
      repo1: ids.map((id) => makeWorktree({ id, repoId: 'repo1', path: id.split('::')[1] }))
    }
  })
  return store
}

function sessionWith(overrides: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return {
    activeRepoId: 'repo1',
    activeWorktreeId: WT_B,
    activeTabId: 'tab-b',
    tabsByWorktree: {
      [WT_A]: [makeTab({ id: 'tab-a', worktreeId: WT_A })],
      [WT_B]: [makeTab({ id: 'tab-b', worktreeId: WT_B })]
    },
    terminalLayoutsByTabId: { 'tab-a': makeLayout(), 'tab-b': makeLayout() },
    ...overrides
  }
}

describe('worktree split view session restore', () => {
  it('restores the pair with the active worktree in the same hydration update', () => {
    const store = storeWithWorktrees([WT_A, WT_B])
    const seen: (WorktreeSplitViewPair | null)[] = []
    store.subscribe((s) => {
      if (s.activeWorktreeId === WT_B) {
        seen.push(s.worktreeSplitViewPair)
      }
    })

    store.getState().hydrateWorkspaceSession(sessionWith({ worktreeSplitViewPair: PAIR }))

    expect(store.getState().worktreeSplitViewPair).toEqual(PAIR)
    // No frame shows the active worktree alone before the split appears.
    expect(seen[0]).toEqual(PAIR)
  })

  it('drops the pair when one side no longer exists', () => {
    const store = storeWithWorktrees([WT_B])
    store.getState().hydrateWorkspaceSession(sessionWith({ worktreeSplitViewPair: PAIR }))

    expect(store.getState().activeWorktreeId).toBe(WT_B)
    expect(store.getState().worktreeSplitViewPair).toBeNull()
  })

  it('restores a tabless side of a repo whose worktrees have not listed yet', () => {
    const store = storeWithWorktrees([])
    store.getState().hydrateWorkspaceSession(
      sessionWith({
        worktreeSplitViewPair: PAIR,
        tabsByWorktree: { [WT_B]: [makeTab({ id: 'tab-b', worktreeId: WT_B })] },
        terminalLayoutsByTabId: { 'tab-b': makeLayout() }
      })
    )

    expect(store.getState().activeWorktreeId).toBe(WT_B)
    expect(store.getState().worktreeSplitViewPair).toEqual(PAIR)
  })

  it('ends the split when a scoped merge moves focus outside the pair', () => {
    const WT_C = 'repo1::/path/c'
    const store = storeWithWorktrees([WT_A, WT_B, WT_C])
    store.setState({ activeWorktreeId: WT_A, worktreeSplitViewPair: PAIR })

    store.getState().hydrateWorkspaceSession(
      sessionWith({
        activeWorktreeId: WT_C,
        activeTabId: 'tab-c',
        tabsByWorktree: { [WT_C]: [makeTab({ id: 'tab-c', worktreeId: WT_C })] },
        terminalLayoutsByTabId: { 'tab-c': makeLayout() }
      }),
      { replaceWorkspaceKeys: [WT_A, WT_C] }
    )

    expect(store.getState().activeWorktreeId).toBe(WT_C)
    expect(store.getState().worktreeSplitViewPair).toBeNull()
  })

  it('keeps the live split when a scoped merge leaves focus inside the pair', () => {
    const store = storeWithWorktrees([WT_A, WT_B])
    store.setState({ activeWorktreeId: WT_A, worktreeSplitViewPair: PAIR })

    store
      .getState()
      .hydrateWorkspaceSession(sessionWith({ activeWorktreeId: WT_A, activeTabId: 'tab-a' }), {
        replaceWorkspaceKeys: [WT_A]
      })

    expect(store.getState().activeWorktreeId).toBe(WT_A)
    expect(store.getState().worktreeSplitViewPair).toEqual(PAIR)
  })

  it('loads a session written before the field existed', () => {
    const store = storeWithWorktrees([WT_A, WT_B])
    store.getState().hydrateWorkspaceSession(sessionWith({}))

    expect(store.getState().worktreeSplitViewPair).toBeNull()
  })

  it('writes the pair, and an ended split as null, into the persisted session', () => {
    const store = storeWithWorktrees([WT_A, WT_B])
    store.setState({ activeWorktreeId: WT_B, worktreeSplitViewPair: PAIR })
    expect(buildWorkspaceSessionPayload(store.getState()).worktreeSplitViewPair).toEqual(PAIR)
    expect(
      buildWorkspaceSessionPatch(store.getState(), ['worktreeSplitViewPair']).worktreeSplitViewPair
    ).toEqual(PAIR)

    store.getState().closeWorktreeSplitView()
    expect(buildWorkspaceSessionPatch(store.getState(), ['worktreeSplitViewPair'])).toEqual({
      worktreeSplitViewPair: null
    })
  })

  it('keeps the pair across a trip to settings', () => {
    const store = storeWithWorktrees([WT_A, WT_B])
    store.setState({ activeView: 'terminal', activeWorktreeId: WT_A, worktreeSplitViewPair: PAIR })

    store.getState().openSettingsPage()
    store.getState().closeSettingsPage()

    expect(store.getState().activeView).toBe('terminal')
    expect(store.getState().worktreeSplitViewPair).toEqual(PAIR)
  })
})
