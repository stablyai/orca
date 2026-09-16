import { describe, expect, it } from 'vitest'
import type { Tab, TabContentType } from '../../../../../shared/tab-types'
import { buildHydratedTabState } from '../tabs-hydration'
import { resolveActivatedWorktreeSurface } from '../worktrees/session/active-worktree-surface'
import { deriveActiveSurfaceForWorktree } from './tabs-surface'

type SelectionState = Parameters<typeof resolveActivatedWorktreeSurface>[0]

const workspace = 'repo::/workspace'
function selectedTab(contentType: TabContentType): Tab {
  return {
    id: 'selected',
    entityId: 'selected-entity',
    groupId: 'group',
    worktreeId: workspace,
    contentType,
    label: 'Selected',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function selectionState(tab: Tab | null): SelectionState {
  return {
    rightSidebarExplorerViewByWorktree: {},
    activeGroupIdByWorktree: { [workspace]: 'group' },
    groupsByWorktree: {
      [workspace]: [
        {
          id: 'group',
          worktreeId: workspace,
          activeTabId: tab?.id ?? null,
          tabOrder: tab ? [tab.id] : []
        }
      ]
    },
    unifiedTabsByWorktree: { [workspace]: tab ? [tab] : [] },
    layoutByWorktree: {},
    activeTabIdByWorktree: { [workspace]: 'remembered-terminal' },
    activeFileIdByWorktree: { [workspace]: 'remembered-file' },
    activeBrowserTabIdByWorktree: { [workspace]: 'remembered-browser' },
    activeTabTypeByWorktree: { [workspace]: 'browser' },
    tabsByWorktree: {
      [workspace]: [
        {
          id: 'remembered-terminal',
          worktreeId: workspace,
          ptyId: null,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    browserTabsByWorktree: {
      [workspace]: [
        {
          id: 'remembered-browser',
          worktreeId: workspace,
          url: 'about:blank',
          title: 'Browser',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
    },
    openFiles: [
      {
        id: 'remembered-file',
        worktreeId: workspace,
        filePath: '/workspace/file',
        relativePath: 'file',
        language: 'plaintext',
        isDirty: false,
        mode: 'edit'
      }
    ]
  }
}

function activate(state: SelectionState) {
  const { restoredRightSidebarExplorerView: _view, ...surface } = resolveActivatedWorktreeSurface(
    state,
    workspace,
    undefined,
    null
  )
  return surface
}

describe('tab selection and hydration ownership', () => {
  it.each([
    ['terminal', 'terminal'],
    ['editor', 'editor'],
    ['diff', 'editor'],
    ['conflict-review', 'editor'],
    ['check-details', 'editor'],
    ['browser', 'browser'],
    ['simulator', 'simulator'],
    ['agent-session', 'agent-session']
  ] as const)(
    'projects %s selection while retaining other remembered surfaces',
    (kind, visible) => {
      const state = selectionState(selectedTab(kind))
      const expected = {
        activeTabType: visible,
        activeTabId: kind === 'terminal' ? 'selected-entity' : 'remembered-terminal',
        activeFileId: visible === 'editor' ? 'selected-entity' : 'remembered-file',
        activeBrowserTabId: kind === 'browser' ? 'selected-entity' : 'remembered-browser'
      }
      expect(deriveActiveSurfaceForWorktree(state, workspace)).toEqual(expected)
      expect(activate(state)).toEqual(expected)
    }
  )

  it('keeps empty groups authoritative over remembered browser/editor surfaces', () => {
    const state = selectionState(null)
    expect(activate(state).activeTabType).toBe('terminal')
    expect(deriveActiveSurfaceForWorktree(state, workspace).activeTabType).toBe('terminal')
  })

  it('keeps layout-only ownership authoritative during staged hydration', () => {
    const state = selectionState(null)
    state.groupsByWorktree = {}
    state.layoutByWorktree = { [workspace]: { type: 'leaf', groupId: 'pending' } }
    expect(activate(state).activeTabType).toBe('terminal')
    expect(deriveActiveSurfaceForWorktree(state, workspace).activeTabType).toBe('terminal')
  })

  it('distinguishes workspace restoration from group-focus legacy fallback', () => {
    const state = selectionState(null)
    state.groupsByWorktree = {}
    state.activeTabTypeByWorktree[workspace] = 'terminal'
    expect(activate(state).activeTabType).toBe('terminal')
    expect(deriveActiveSurfaceForWorktree(state, workspace).activeTabType).toBe('browser')
  })

  it('does not select a preferred tab owned by another group', () => {
    const state = selectionState(selectedTab('browser'))
    state.unifiedTabsByWorktree[workspace].push({
      ...selectedTab('editor'),
      id: 'foreign',
      groupId: 'other'
    })
    expect(resolveActivatedWorktreeSurface(state, workspace, 'foreign', null).activeTabType).toBe(
      'terminal'
    )
  })

  it('resolves stale active-group IDs to the first group consistently', () => {
    const state = selectionState(selectedTab('simulator'))
    state.activeGroupIdByWorktree[workspace] = 'removed'
    expect(activate(state).activeTabType).toBe('simulator')
    expect(deriveActiveSurfaceForWorktree(state, workspace).activeTabType).toBe('simulator')
  })

  it('requires group ownership even for an explicit preferred tab during hydration', () => {
    const state = selectionState(selectedTab('simulator'))
    state.groupsByWorktree = {}
    state.activeTabTypeByWorktree[workspace] = 'terminal'
    expect(resolveActivatedWorktreeSurface(state, workspace, 'selected', null).activeTabType).toBe(
      'terminal'
    )
  })

  it('honors a preferred tab in the selected group without mutating selection', () => {
    const state = selectionState(selectedTab('browser'))
    const preferred = { ...selectedTab('simulator'), id: 'preferred' }
    state.unifiedTabsByWorktree[workspace].push(preferred)
    state.groupsByWorktree[workspace][0].tabOrder.push(preferred.id)
    expect(
      resolveActivatedWorktreeSurface(state, workspace, preferred.id, null).activeTabType
    ).toBe('simulator')
    expect(state.groupsByWorktree[workspace][0].activeTabId).toBe('selected')
  })

  it.each([
    ['terminal', 'terminal', 'remembered-file'],
    ['editor', 'editor', 'remembered-file'],
    ['browser', 'browser', 'remembered-file'],
    // Why: nothing renders a remembered agent-session/simulator once its tab is gone, so the browser
    // surface takes over and must not leave the remembered file selected underneath it.
    ['agent-session', 'browser', null],
    ['simulator', 'browser', null]
  ] as const)(
    'projects legacy %s memory as %s when unified groups are absent',
    (activeTabType, visible, activeFileId) => {
      const state = selectionState(null)
      state.groupsByWorktree = {}
      state.activeTabTypeByWorktree[workspace] = activeTabType
      expect(activate(state)).toEqual({
        activeTabType: visible,
        activeTabId: 'remembered-terminal',
        activeFileId,
        activeBrowserTabId: 'remembered-browser'
      })
    }
  )

  it('hydrates unified selection without allowing conflicting legacy memories to choose it', () => {
    const tab = selectedTab('simulator')
    const state = selectionState(tab)
    const session = {
      activeRepoId: null,
      activeWorktreeId: workspace,
      activeTabId: 'remembered-terminal',
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      unifiedTabs: state.unifiedTabsByWorktree,
      tabGroups: state.groupsByWorktree,
      activeGroupIdByWorktree: state.activeGroupIdByWorktree,
      activeTabTypeByWorktree: { [workspace]: 'browser' as const },
      activeTabIdByWorktree: state.activeTabIdByWorktree
    }
    const before = structuredClone(session)
    const hydrated = buildHydratedTabState(session, new Set([workspace]))
    expect(activate({ ...state, ...hydrated }).activeTabType).toBe('simulator')
    expect(session).toEqual(before)
  })
})
