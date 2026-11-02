// Main’s load must match window browser hydration so the window never invents a tab ID main cannot resolve (L280).

import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../constants'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../execution-host'
import type { Tab } from '../tab-types'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { resolveSessionTabRow } from './old-client/old-client-session-tab-rows'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { nameBasedLoadContext } from './workspace-layout-minted-ids'
import { saveWorkspaceLayout } from './workspace-layout-save'

vi.mock('../layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const KEY = 'repo-1::/w'

function editor(id: string, groupId: string, sortOrder: number): Tab {
  return {
    id,
    entityId: `/w/${id}.ts`,
    groupId,
    worktreeId: KEY,
    contentType: 'editor',
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: 1
  }
}

function savedSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    unifiedTabs: { [KEY]: [editor('a', 'g1', 0), editor('b', 'g2', 0)] },
    tabGroups: {
      [KEY]: [
        { id: 'g1', worktreeId: KEY, activeTabId: 'a', tabOrder: ['a'] },
        { id: 'g2', worktreeId: KEY, activeTabId: 'b', tabOrder: ['b'] }
      ]
    },
    activeGroupIdByWorktree: { [KEY]: 'g2' },
    openFilesByWorktree: {
      [KEY]: ['a', 'b'].map((name) => ({
        filePath: `/w/${name}.ts`,
        relativePath: `${name}.ts`,
        worktreeId: KEY,
        language: 'typescript'
      }))
    },
    browserTabsByWorktree: {
      [KEY]: [
        {
          id: 'browser-1',
          worktreeId: KEY,
          url: 'https://example.com',
          title: 'Example',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 5
        }
      ]
    }
  }
}

// As main's projection loads it after a restart: its views carried, none held.
const load = (session: WorkspaceSessionState, hostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID) =>
  loadWorkspaceLayout(hostId, session, {
    ...nameBasedLoadContext(),
    editorViewsOf: () => undefined
  })

describe("main's load of a browser record with no tab", () => {
  it('gives it a tab at the end of the active group, which a row id resolves to', () => {
    const workspace = load(savedSession()).layout.workspaces[KEY]!
    const tab = workspace.tabs.find((entry) => entry.kind === 'browser')!

    expect(tab).toMatchObject({ entityId: 'browser-1', createdAt: 5 })
    expect(workspace.groups.map((group) => group.tabOrder)).toEqual([['a'], ['b', tab.id]])
    // The window publishes a browser row under its record id.
    expect(resolveSessionTabRow(workspace, 'browser-1')?.tab.id).toBe(tab.id)
  })

  it('mints the same id on every load, and a restart after a save keeps one tab', () => {
    const ids = (session: WorkspaceSessionState) =>
      load(session)
        .layout.workspaces[KEY]!.tabs.filter((tab) => tab.kind === 'browser')
        .map((tab) => tab.id)
    const first = ids(savedSession())

    expect(ids(savedSession())).toEqual(first)
    expect(ids(saveWorkspaceLayout(load(savedSession())))).toEqual(first)
    expect(first).toHaveLength(1)
  })

  // Load repairs use saved data without contacting SSH; an unreachable host is not evidence of absence.
  it('repairs and drops the same in a direct SSH partition, whose host it never contacts', () => {
    const session = savedSession()
    session.unifiedTabs![KEY]!.push({
      ...editor('ghost', 'g2', 1),
      contentType: 'diff',
      entityId: '/w/gone.ts'
    })
    const tabsOf = (hostId: ExecutionHostId) =>
      load(session, hostId).layout.workspaces[KEY]!.tabs.map((tab) => [tab.id, tab.kind])

    expect(tabsOf('ssh:box')).toEqual(tabsOf(LOCAL_EXECUTION_HOST_ID))
    expect(tabsOf('ssh:box')).toContainEqual([expect.any(String), 'browser'])
    expect(tabsOf('ssh:box').map(([id]) => id)).toEqual(expect.arrayContaining(['a', 'b']))
    expect(tabsOf('ssh:box').map(([id]) => id)).not.toContain('ghost')
  })

  it('skips a saved active group this load empties, as the window picks a group that holds a tab', () => {
    const session = savedSession()
    session.unifiedTabs![KEY] = [
      { ...editor('a', 'g1', 0), id: 'ghost', contentType: 'diff', entityId: '/w/gone.ts' },
      editor('b', 'g2', 0)
    ]
    session.tabGroups![KEY] = [
      { id: 'g1', worktreeId: KEY, activeTabId: 'ghost', tabOrder: ['ghost'] },
      { id: 'g2', worktreeId: KEY, activeTabId: 'b', tabOrder: ['b'] }
    ]
    session.activeGroupIdByWorktree = { [KEY]: 'g1' }

    const workspace = load(session).layout.workspaces[KEY]!
    const tab = workspace.tabs.find((entry) => entry.kind === 'browser')!

    expect(workspace.groups).toEqual([{ id: 'g2', tabOrder: ['b', tab.id] }])
  })
})
