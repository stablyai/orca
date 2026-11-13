// SLEEP-HOME-REGRESSION: emptying the workspace on screen leaves it for Home, except a cloud workspace
// held asleep on screen: its asleep view covers the workspace even with no tab (a chat asleep).
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

type Store = {
  state: {
    activeWorktreeId: string | null
    setActiveWorktree: Mock<(id: string | null) => void>
    reconcileWorktreeTabModel: () => { renderableTabCount: number }
  }
}

const store = vi.hoisted((): Store => ({
  state: {
    activeWorktreeId: 'ws',
    setActiveWorktree: vi.fn((id: string | null) => {
      store.state.activeWorktreeId = id
    }),
    reconcileWorktreeTabModel: () => ({ renderableTabCount: 0 })
  }
}))
vi.mock('../../store', () => ({ useAppStore: { getState: () => store.state } }))
vi.mock('@/store/slices/tabs/split-landing-groups', () => ({ hasSplitLandingGroup: () => false }))
vi.mock('@/components/floating-terminal/floating-workspace-focus-reclaim', () => ({
  armFloatingPanelReclaimIntent: vi.fn()
}))
vi.mock('@/components/floating-terminal/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => false
}))
vi.mock('@/store/workspaces/floating/floating-workspace-panel-selector', () => ({
  selectFloatingVisibleTabCount: () => 0
}))

import { captureWorkspaceEmptiedReaction } from './workspace-emptied-reaction'
import { holdWorktreeSleepView, resetWorktreeSleepViewForTests } from '@/lib/worktree-sleep-view'

beforeEach(() => {
  store.state.activeWorktreeId = 'ws'
  store.state.setActiveWorktree.mockClear()
})
afterEach(() => resetWorktreeSleepViewForTests())

describe('the last tab of the workspace on screen closes', () => {
  it('leaves the emptied workspace (for Home)', () => {
    captureWorkspaceEmptiedReaction('ws')()
    expect(store.state.setActiveWorktree).toHaveBeenCalledWith(null)
  })

  it('stays on a cloud workspace held asleep on screen', () => {
    holdWorktreeSleepView('ws')
    captureWorkspaceEmptiedReaction('ws')()
    expect(store.state.setActiveWorktree).not.toHaveBeenCalled()
    expect(store.state.activeWorktreeId).toBe('ws')
  })
})
