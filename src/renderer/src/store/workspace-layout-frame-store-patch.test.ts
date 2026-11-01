import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import { localDesktopSession } from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import { GIT_KEY } from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { bootWindowFromPartitions } from '../app-shell/startup-window-view.test-fixture'
import { createStoreSessionMockApi } from './slices/store-session-test-harness'
import { createTestStore } from './slices/store-test-helpers'
import type { AppState } from './types'
import { buildLayoutFrameSlices } from './workspace-layout-frame-slices'
import { buildLayoutFrameStorePatch } from './workspace-layout-frame-store-patch'
import {
  DESKTOP_CREATED_SERVER_TAB_HOLDS,
  _resetDesktopCreatedServerTabsForTests,
  noteDesktopCreatedServerTab
} from '@/lib/desktop-created-server-tabs'

// Off as the build ships; the desktop-created record exists only with it on.
const layoutOwner = vi.hoisted(() => ({ on: false }))
vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.on
  }
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

async function restored(): Promise<{
  state: AppState
  session: WorkspaceSessionState
  frame: PublishedWorkspaceLayout
}> {
  const session = localDesktopSession()
  const state = await bootWindowFromPartitions(createTestStore(), [{ hostId: 'local', session }])
  const { layout } = loadWorkspaceLayoutWithoutReport('local', session, nameBasedLoadContext())
  return { state, session, frame: publishWorkspaceLayout(layout.workspaces[GIT_KEY]!, 'local') }
}

/** The patch that shows `frame` for the git workspace, with the stored session's view and facts. */
function patchFor(
  state: AppState,
  session: WorkspaceSessionState,
  frame: PublishedWorkspaceLayout,
  ...windowSide: Parameters<typeof buildLayoutFrameStorePatch> extends [
    unknown,
    unknown,
    unknown,
    ...infer Rest
  ]
    ? Rest
    : never
) {
  const { facts, desktopView } = loadWorkspaceLayoutWithoutReport(
    'local',
    session,
    nameBasedLoadContext()
  )
  const built = buildLayoutFrameSlices({ layouts: { [GIT_KEY]: frame }, facts, view: desktopView })
  return buildLayoutFrameStorePatch(state, built, [GIT_KEY], ...windowSide)
}

function withoutTab(frame: PublishedWorkspaceLayout, tabId: string): PublishedWorkspaceLayout {
  return {
    ...frame,
    groups: frame.groups.map((group) => ({
      ...group,
      tabIds: group.tabIds.filter((id) => id !== tabId)
    })),
    tabs: frame.tabs.filter((tab) => tab.id !== tabId)
  }
}

describe('laying frame slices over the store', () => {
  it('drops a terminal tab main closed, with its pane layout', async () => {
    const { state, session, frame } = await restored()
    const patch = patchFor(state, session, withoutTab(frame, 'tab-shell'))
    expect(patch.tabsByWorktree?.[GIT_KEY]?.map((tab) => tab.id)).not.toContain('tab-shell')
    expect(patch.terminalLayoutsByTabId).not.toHaveProperty('tab-shell')
    expect(patch.unifiedTabsByWorktree?.[GIT_KEY]?.map((tab) => tab.id)).not.toContain('tab-shell')
  })

  it('keeps the pane layout of a tab the window’s own pane command holds, until main drops the tab', async () => {
    const { state, session, frame } = await restored()
    const newRatios: PublishedWorkspaceLayout = {
      ...frame,
      tabs: frame.tabs.map((tab) =>
        tab.id === 'tab-shell' && tab.terminal?.root?.type === 'split'
          ? { ...tab, terminal: { ...tab.terminal, root: { ...tab.terminal.root, ratio: 0.2 } } }
          : tab
      )
    }
    const held = (id: string): boolean => id === 'tab-shell'

    expect(patchFor(state, session, newRatios).terminalLayoutsByTabId?.['tab-shell']).toBeDefined()
    expect(patchFor(state, session, newRatios, held).terminalLayoutsByTabId).toBeUndefined()
    expect(
      patchFor(state, session, withoutTab(frame, 'tab-shell'), held).terminalLayoutsByTabId
    ).not.toHaveProperty('tab-shell')
  })

  it('keeps an open file’s editor state and place, and drops a file main closed', async () => {
    const { state, session, frame } = await restored()
    const file = state.openFiles.find((entry) => entry.worktreeId === GIT_KEY)!
    const edited = { ...state, openFiles: [{ ...file, isDirty: true }] }
    expect(patchFor(edited, session, frame).openFiles).toBeUndefined()
    const closed = patchFor(edited, session, {
      ...withoutTab(frame, 'editor:src/app.ts'),
      editorFiles: []
    })
    expect(closed.openFiles).toEqual([])
  })

  it('keeps a browser tab’s page state, and drops the pages of a tab main closed', async () => {
    const { state, session, frame } = await restored()
    const browser = state.browserTabsByWorktree[GIT_KEY]![0]!
    const browsing = {
      ...state,
      browserTabsByWorktree: { [GIT_KEY]: [{ ...browser, url: 'https://example.com/next' }] }
    }
    expect(patchFor(browsing, session, frame).browserTabsByWorktree).toBeUndefined()
    const closed = patchFor(browsing, session, {
      ...withoutTab(frame, 'browser-1'),
      browserTabs: []
    })
    expect(closed.browserPagesByWorkspace).not.toHaveProperty('browser-1')
  })

  it('keeps a client-hosted browser tab this desktop created, with its page and handle, at its place (L274)', async () => {
    const { state, session, frame } = await restored()
    const page = state.browserPagesByWorkspace['browser-1']![0]!
    const handle = {
      environmentId: 'web-env-1',
      remotePageId: 'server-page-1',
      placement: {
        kind: 'client' as const,
        browserHostClientId: 'this-desktop',
        browserHostGeneration: 1,
        pageHostGeneration: 1
      }
    }
    const hosting = {
      ...state,
      remoteBrowserPageHandlesByPageId: {
        ...state.remoteBrowserPageHandlesByPageId,
        [page.id]: handle
      }
    }
    const groupOf = (tabs: AppState['groupsByWorktree']) =>
      tabs[GIT_KEY]!.find((group) => group.tabOrder.includes('browser-1'))
    const order = groupOf(state.groupsByWorktree)!.tabOrder
    // The server's frame lists every tab but the one this desktop hosts.
    const serverFrame = { ...withoutTab(frame, 'browser-1'), browserTabs: [] }
    layoutOwner.on = true
    noteDesktopCreatedServerTab('web-env-1', GIT_KEY, 'browser-1')
    try {
      const patch = patchFor(
        hosting,
        session,
        serverFrame,
        undefined,
        undefined,
        DESKTOP_CREATED_SERVER_TAB_HOLDS
      )
      const after = { ...hosting, ...patch }
      expect(after.unifiedTabsByWorktree[GIT_KEY]!.map((tab) => tab.id)).toContain('browser-1')
      expect(groupOf(after.groupsByWorktree)?.tabOrder).toEqual(order)
      expect(after.browserTabsByWorktree[GIT_KEY]!.map((tab) => tab.id)).toContain('browser-1')
      expect(after.browserPagesByWorkspace['browser-1']).toEqual([page])
      expect(after.remoteBrowserPageHandlesByPageId[page.id]).toEqual(handle)
    } finally {
      _resetDesktopCreatedServerTabsForTests()
      layoutOwner.on = false
    }
    // Presence: without the hold, the same frame drops all three.
    const dropped = patchFor(hosting, session, serverFrame)
    expect(dropped.browserPagesByWorkspace).not.toHaveProperty('browser-1')
    expect(dropped.remoteBrowserPageHandlesByPageId).not.toHaveProperty(page.id)
  })
})
