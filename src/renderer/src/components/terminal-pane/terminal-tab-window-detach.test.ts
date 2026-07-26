import { describe, expect, it, vi } from 'vitest'
import type { TabGroup, TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import {
  captureTerminalTabForWindowDetach,
  reintegrateDetachedTerminalTab
} from './terminal-tab-window-detach'

const LEAF_1 = '11111111-1111-4111-8111-111111111111'

const makeTab = (overrides: Partial<TerminalTab> = {}): TerminalTab => ({
  id: 'tab-1',
  ptyId: 'pty-1',
  worktreeId: 'wt-1',
  title: 'Terminal 1',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  ...overrides
})

const makeGroup = (overrides: Partial<TabGroup> = {}): TabGroup => ({
  id: 'group-1',
  worktreeId: 'wt-1',
  activeTabId: 'tab-1',
  tabOrder: ['tab-1'],
  ...overrides
})

const makeLayout = (): TerminalLayoutSnapshot => ({
  root: { type: 'leaf', leafId: LEAF_1 },
  activeLeafId: LEAF_1,
  expandedLeafId: null,
  ptyIdsByLeafId: { [LEAF_1]: 'pty-1' }
})

const REPO = {
  id: 'wt-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 0,
  connectionId: null,
  executionHostId: null
}

describe('captureTerminalTabForWindowDetach', () => {
  it('builds a seed from the tab, its owning group, and its live layout', () => {
    const layout = makeLayout()
    const store = {
      tabsByWorktree: { 'wt-1': [makeTab()] },
      groupsByWorktree: { 'wt-1': [makeGroup()] },
      terminalLayoutsByTabId: { 'tab-1': layout },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      repos: [REPO]
    }

    const seed = captureTerminalTabForWindowDetach(store, 'wt-1', 'tab-1')

    expect(seed).toEqual({
      worktreeId: 'wt-1',
      groupId: 'group-1',
      tab: makeTab(),
      layout,
      ptyId: 'pty-1',
      repo: REPO
    })
  })

  it('returns null when the tab is not found in the worktree', () => {
    const store = {
      tabsByWorktree: { 'wt-1': [] },
      groupsByWorktree: { 'wt-1': [makeGroup()] },
      terminalLayoutsByTabId: {},
      ptyIdsByTabId: {},
      repos: [REPO]
    }
    expect(captureTerminalTabForWindowDetach(store, 'wt-1', 'tab-1')).toBeNull()
  })

  it('returns null when no group owns the tab', () => {
    const store = {
      tabsByWorktree: { 'wt-1': [makeTab()] },
      groupsByWorktree: { 'wt-1': [makeGroup({ tabOrder: [] })] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout() },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      repos: [REPO]
    }
    expect(captureTerminalTabForWindowDetach(store, 'wt-1', 'tab-1')).toBeNull()
  })

  it('returns null when the tab has no live layout', () => {
    const store = {
      tabsByWorktree: { 'wt-1': [makeTab()] },
      groupsByWorktree: { 'wt-1': [makeGroup()] },
      terminalLayoutsByTabId: {},
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      repos: [REPO]
    }
    expect(captureTerminalTabForWindowDetach(store, 'wt-1', 'tab-1')).toBeNull()
  })

  it('returns null when repo metadata is missing', () => {
    const store = {
      tabsByWorktree: { 'wt-1': [makeTab()] },
      groupsByWorktree: { 'wt-1': [makeGroup()] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout() },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      repos: []
    }
    expect(captureTerminalTabForWindowDetach(store, 'wt-1', 'tab-1')).toBeNull()
  })
})

describe('reintegrateDetachedTerminalTab', () => {
  it('recreates the tab in its source group and restores layout/color/title/active state', () => {
    const layout = makeLayout()
    const seed = {
      worktreeId: 'wt-1',
      groupId: 'group-1',
      tab: makeTab({ customTitle: 'My shell', color: '#ef4444' }),
      layout,
      ptyId: 'pty-1',
      repo: REPO
    }
    const store = {
      groupsByWorktree: { 'wt-1': [makeGroup()] },
      createTab: vi.fn(),
      setTabLayout: vi.fn(),
      setActiveTab: vi.fn(),
      setTabCustomTitle: vi.fn(),
      setTabColor: vi.fn()
    }

    reintegrateDetachedTerminalTab(store, seed)

    expect(store.createTab).toHaveBeenCalledWith('wt-1', 'group-1', undefined, {
      id: 'tab-1',
      initialPtyId: 'pty-1'
    })
    expect(store.setTabLayout).toHaveBeenCalledWith('tab-1', layout)
    expect(store.setTabCustomTitle).toHaveBeenCalledWith('tab-1', 'My shell')
    expect(store.setTabColor).toHaveBeenCalledWith('tab-1', '#ef4444')
    expect(store.setActiveTab).toHaveBeenCalledWith('tab-1')
  })

  it('falls back to no target group when the source group no longer exists', () => {
    const seed = {
      worktreeId: 'wt-1',
      groupId: 'stale-group',
      tab: makeTab(),
      layout: makeLayout(),
      ptyId: 'pty-1',
      repo: REPO
    }
    const store = {
      groupsByWorktree: { 'wt-1': [makeGroup()] },
      createTab: vi.fn(),
      setTabLayout: vi.fn(),
      setActiveTab: vi.fn(),
      setTabCustomTitle: vi.fn(),
      setTabColor: vi.fn()
    }

    reintegrateDetachedTerminalTab(store, seed)

    expect(store.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      id: 'tab-1',
      initialPtyId: 'pty-1'
    })
    expect(store.setTabCustomTitle).not.toHaveBeenCalled()
    expect(store.setTabColor).not.toHaveBeenCalled()
  })
})
