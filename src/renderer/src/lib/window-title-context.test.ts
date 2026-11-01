// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { Tab } from '../../../shared/tab-types'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makeFolderWorkspace, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { selectWindowTitle } from './window-title-context'

function makeTab(overrides: Partial<Tab> & { id: string; worktreeId: string }): Tab {
  return {
    entityId: overrides.id,
    groupId: 'group-1',
    contentType: 'terminal',
    label: 'Shell 1',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function baseState(enabled = true): AppState {
  const initial = useAppStore.getInitialState()
  return {
    ...initial,
    settings: { ...initial.settings!, windowTitleShowWorkspace: enabled },
    activeView: 'terminal',
    repos: [
      {
        id: 'repo',
        displayName: 'orca',
        path: '/orca',
        connectionId: null,
        badgeColor: 'blue',
        addedAt: 0
      }
    ],
    worktreesByRepo: {
      repo: [
        makeWorktree({
          id: 'wt',
          repoId: 'repo',
          displayName: 'Window title work',
          branch: 'refs/heads/feat/window-title'
        })
      ]
    },
    activeWorktreeId: 'wt',
    unifiedTabsByWorktree: {
      wt: [makeTab({ id: 'tab-1', worktreeId: 'wt', label: 'Claude Code' })]
    },
    groupsByWorktree: {
      wt: [{ id: 'group-1', worktreeId: 'wt', activeTabId: 'tab-1', tabOrder: ['tab-1'] }]
    },
    activeGroupIdByWorktree: { wt: 'group-1' }
  }
}

describe('selectWindowTitle', () => {
  it('stays the plain app title while the toggle is off', () => {
    expect(selectWindowTitle(baseState(false))).toBe('Orca')
  })

  it('names the project, branch and focused session of a git worktree', () => {
    expect(selectWindowTitle(baseState())).toBe('orca — feat/window-title — Claude Code — Orca')
  })

  it('uses only the focused group tab, not other groups', () => {
    const state = baseState()
    state.unifiedTabsByWorktree.wt.push(
      makeTab({ id: 'tab-2', worktreeId: 'wt', groupId: 'group-2', label: 'Other' })
    )
    state.groupsByWorktree.wt.push({
      id: 'group-2',
      worktreeId: 'wt',
      activeTabId: 'tab-2',
      tabOrder: ['tab-2']
    })
    expect(selectWindowTitle(state)).toContain('Claude Code')
    state.activeGroupIdByWorktree = { wt: 'group-2' }
    expect(selectWindowTitle(state)).toBe('orca — feat/window-title — Other — Orca')
  })

  it('strips agent spinner glyphs from the tab label', () => {
    const state = baseState()
    state.unifiedTabsByWorktree.wt[0].label = '⠋ Claude Code'
    expect(selectWindowTitle(state)).toBe('orca — feat/window-title — Claude Code — Orca')
  })

  it('names the workspace in the branch slot for a folder workspace', () => {
    const state = baseState()
    state.folderWorkspaces = [
      makeFolderWorkspace({ id: 'folder-id', projectGroupId: 'group', name: 'my-docs' })
    ]
    state.projectGroups = [
      {
        id: 'group',
        name: 'Docs Group',
        parentPath: null,
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 0,
        updatedAt: 0
      }
    ]
    state.activeWorktreeId = 'folder:folder-id'
    state.unifiedTabsByWorktree['folder:folder-id'] = [
      makeTab({ id: 'tab-f', worktreeId: 'folder:folder-id', label: 'Shell 1' })
    ]
    state.groupsByWorktree['folder:folder-id'] = [
      { id: 'group-1', worktreeId: 'folder:folder-id', activeTabId: 'tab-f', tabOrder: ['tab-f'] }
    ]
    state.activeGroupIdByWorktree['folder:folder-id'] = 'group-1'
    expect(selectWindowTitle(state)).toBe('Docs Group — my-docs — Shell 1 — Orca')
  })

  it('titles the floating workspace without a project', () => {
    const state = baseState()
    state.floatingWorkspacePath = '/tmp/floating'
    state.activeWorktreeId = FLOATING_TERMINAL_WORKTREE_ID
    expect(selectWindowTitle(state)).toBe('Floating workspace — Orca')
  })

  it('falls back to the app title with no active workspace', () => {
    const state = baseState()
    state.activeWorktreeId = null
    expect(selectWindowTitle(state)).toBe('Orca')
  })

  it.each([
    ['tasks', 'Tasks — Orca'],
    ['settings', 'Settings — Orca']
  ] as const)('drops the workspace outside the workspace view (%s)', (view, expected) => {
    const state = baseState()
    state.activeView = view
    expect(selectWindowTitle(state)).toBe(expected)
  })
})
