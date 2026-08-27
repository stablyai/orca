// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'

const mocks = vi.hoisted(() => ({
  closeWebRuntimeSessionTab: vi.fn(async (_args: { environmentId: string | null }) => true),
  isWebRuntimeSessionActive: vi.fn(() => true),
  closeTerminalTab: vi.fn(),
  destroyWorkspaceWebviews: vi.fn(),
  requestEditorFileClose: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(() => null as string | null)
}))

vi.mock('../../runtime/web-runtime-session', () => ({
  closeWebRuntimeSessionTab: mocks.closeWebRuntimeSessionTab,
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive
}))
vi.mock('../terminal/terminal-tab-actions', () => ({ closeTerminalTab: mocks.closeTerminalTab }))
vi.mock('../../store/slices/browser-webview-cleanup', () => ({
  destroyWorkspaceWebviews: mocks.destroyWorkspaceWebviews
}))
vi.mock('../editor/editor-autosave', () => ({
  requestEditorFileClose: mocks.requestEditorFileClose
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))

import { useAppStore } from '../../store'
import { useTabGroupTabCloseCommands } from './useTabGroupTabCloseCommands'

const BROWSER_TAB = {
  id: 'unified-browser',
  contentType: 'browser',
  entityId: 'workspace-a',
  groupId: 'group-1'
} as Tab

let closeUnifiedTab: ReturnType<typeof vi.fn>
let closeBrowserTab: ReturnType<typeof vi.fn>

beforeEach(() => {
  // clearAllMocks leaves implementations in place, so a per-test mockReturnValue would leak.
  mocks.isWebRuntimeSessionActive.mockReturnValue(true)
  mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(null)
  closeUnifiedTab = vi.fn()
  closeBrowserTab = vi.fn()
  useAppStore.setState({
    closeUnifiedTab,
    closeBrowserTab,
    closeTab: vi.fn(),
    closeFile: vi.fn(),
    setActiveWorktree: vi.fn(),
    reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 1 })),
    unifiedTabsByWorktree: { 'worktree-a': [BROWSER_TAB] },
    browserPagesByWorkspace: {
      'workspace-a': [
        { id: 'page-1', workspaceId: 'workspace-a' },
        { id: 'page-2', workspaceId: 'workspace-a' }
      ]
    },
    remoteBrowserPageHandlesByPageId: {
      'page-1': { environmentId: 'env-a', remotePageId: 'remote-1' },
      'page-2': { environmentId: 'env-b', remotePageId: 'remote-2' }
    }
  } as never)
})

afterEach(() => vi.clearAllMocks())

function commands(): ReturnType<typeof useTabGroupTabCloseCommands> {
  return renderHook(() =>
    useTabGroupTabCloseCommands({ worktreeId: 'worktree-a', groupTabs: [BROWSER_TAB] })
  ).result.current
}

/** One page, held under a client-minted handle the host has not published yet. */
function stageWorkspace(workspaceId: string): void {
  useAppStore.setState({
    browserPagesByWorkspace: { [workspaceId]: [{ id: 'page-1', workspaceId }] },
    remoteBrowserPageHandlesByPageId: {
      'page-1': { environmentId: 'env-a', remotePageId: 'remote-1', staged: true }
    }
  } as never)
}

function closedEnvironmentIds(): string[] {
  return mocks.closeWebRuntimeSessionTab.mock.calls
    .map((call) => call[0].environmentId ?? '(unset)')
    .sort()
}

// Why: a workspace whose pages span two environments resolved as "ambiguous", and both close
// paths fell through without doing anything — the X was inert with no error and no teardown.
describe('closing a browser workspace owned by more than one runtime environment', () => {
  it('closes it on every owning host from the single-tab close', () => {
    commands().closeItem('unified-browser')

    expect(closedEnvironmentIds()).toEqual(['env-a', 'env-b'])
    expect(mocks.destroyWorkspaceWebviews).not.toHaveBeenCalled()
  })

  it('closes it on every owning host from the bulk close', () => {
    commands().closeMany(['unified-browser'])

    expect(closedEnvironmentIds()).toEqual(['env-a', 'env-b'])
  })

  it('tears it down locally when neither host is connected', () => {
    mocks.isWebRuntimeSessionActive.mockReturnValue(false)

    commands().closeItem('unified-browser')

    expect(mocks.closeWebRuntimeSessionTab).not.toHaveBeenCalled()
    expect(mocks.destroyWorkspaceWebviews).toHaveBeenCalled()
    expect(closeBrowserTab).toHaveBeenCalledWith('workspace-a', undefined)
    expect(closeUnifiedTab).toHaveBeenCalledWith('unified-browser', undefined)
  })

  // Why: a mirror of a host tab has no page of its own, so nothing names an owner — without the
  // focused runtime standing in, the X removed nothing and the host re-mirrored the tab.
  it('removes a pageless host mirror through the focused runtime', () => {
    useAppStore.setState({
      browserPagesByWorkspace: {},
      remoteBrowserPageHandlesByPageId: {}
    } as never)
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue('env-focused')

    commands().closeItem('unified-browser')

    expect(closedEnvironmentIds()).toEqual(['env-focused'])
    expect(closeUnifiedTab).toHaveBeenCalledWith('unified-browser', undefined)
    expect(mocks.destroyWorkspaceWebviews).not.toHaveBeenCalled()
  })

  it('routes the bulk close through the same plan for a pageless host mirror', () => {
    useAppStore.setState({
      browserPagesByWorkspace: {},
      remoteBrowserPageHandlesByPageId: {}
    } as never)
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue('env-focused')

    commands().closeMany(['unified-browser'])

    expect(closedEnvironmentIds()).toEqual(['env-focused'])
    expect(closeUnifiedTab).toHaveBeenCalledWith('unified-browser', undefined)
  })

  // Why: a staged page names an environment before the host has minted it, so the owner branch
  // would fire an inert close and the in-flight create's snapshot would put the tab back.
  it('unwinds a staged tab locally instead of closing it on the host', () => {
    stageWorkspace('workspace-a')

    commands().closeItem('unified-browser')

    expect(mocks.closeWebRuntimeSessionTab).not.toHaveBeenCalled()
    expect(mocks.destroyWorkspaceWebviews).toHaveBeenCalled()
    expect(closeBrowserTab).toHaveBeenCalledWith('workspace-a', { reason: 'cleanup' })
    expect(closeUnifiedTab).toHaveBeenCalledWith('unified-browser', {
      preserveWorktreeSelection: true,
      recordInteraction: false
    })
  })

  // Why: the empty check answers "the user emptied this worktree". Cancelling a create that never
  // finished is not that — deselecting here drops the user on the landing screen mid-click.
  it('keeps the worktree selected when the unwound staged tab was the last one', () => {
    stageWorkspace('workspace-a')
    const setActiveWorktree = vi.fn()
    useAppStore.setState({
      setActiveWorktree,
      activeWorktreeId: 'worktree-a',
      reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 0 }))
    } as never)

    commands().closeItem('unified-browser')

    expect(setActiveWorktree).not.toHaveBeenCalled()
  })

  // Why: the bail above is only correct if it is narrow. Making it unconditional reads the same in
  // the staged test, so pin the case it must not swallow — a real X on the last real browser tab.
  it('leaves the worktree when a real close empties it', () => {
    mocks.isWebRuntimeSessionActive.mockReturnValue(false)
    const setActiveWorktree = vi.fn()
    useAppStore.setState({
      setActiveWorktree,
      activeWorktreeId: 'worktree-a',
      reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 0 }))
    } as never)

    commands().closeItem('unified-browser')

    expect(closeBrowserTab).toHaveBeenCalledWith('workspace-a', undefined)
    expect(setActiveWorktree).toHaveBeenCalledWith(null)
  })

  // Why: closeMany runs the plan per item, so a staged tab and a real host-mirrored one in the
  // same bulk close must take different routes — the bulk path is where a shared close policy
  // historically went unasserted.
  it('routes a staged tab and a host-mirrored tab differently in one bulk close', () => {
    const hostTab = {
      id: 'unified-browser-2',
      contentType: 'browser',
      entityId: 'workspace-b',
      groupId: 'group-1'
    } as Tab
    stageWorkspace('workspace-a')
    useAppStore.setState({
      unifiedTabsByWorktree: { 'worktree-a': [BROWSER_TAB, hostTab] },
      browserPagesByWorkspace: {
        'workspace-a': [{ id: 'page-1', workspaceId: 'workspace-a' }],
        'workspace-b': [{ id: 'page-3', workspaceId: 'workspace-b' }]
      },
      remoteBrowserPageHandlesByPageId: {
        'page-1': { environmentId: 'env-a', remotePageId: 'remote-1', staged: true },
        'page-3': { environmentId: 'env-b', remotePageId: 'remote-3' }
      }
    } as never)

    renderHook(() =>
      useTabGroupTabCloseCommands({ worktreeId: 'worktree-a', groupTabs: [BROWSER_TAB, hostTab] })
    ).result.current.closeMany(['unified-browser', 'unified-browser-2'])

    expect(closedEnvironmentIds()).toEqual(['env-b'])
    expect(mocks.closeWebRuntimeSessionTab.mock.calls[0]?.[0]).toMatchObject({
      tabId: 'unified-browser-2'
    })
    expect(closeBrowserTab.mock.calls).toEqual([['workspace-a', { reason: 'cleanup' }]])
  })

  it('still leaves a lone owner tab for host sync to remove', () => {
    useAppStore.setState({
      remoteBrowserPageHandlesByPageId: {
        'page-1': { environmentId: 'env-a', remotePageId: 'remote-1' },
        'page-2': { environmentId: 'env-a', remotePageId: 'remote-2' }
      }
    } as never)

    commands().closeItem('unified-browser')

    expect(closedEnvironmentIds()).toEqual(['env-a'])
    expect(closeUnifiedTab).not.toHaveBeenCalled()
    expect(mocks.destroyWorkspaceWebviews).not.toHaveBeenCalled()
  })
})
