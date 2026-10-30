import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useIpcEventsForCloseRouting,
  type CloseActiveTabListener
} from './ipc-events-close-routing-test-harness'

const { closeWebRuntimeSessionTab, destroyWorkspaceWebviews, isWebRuntimeSessionActive } =
  vi.hoisted(() => ({
    closeWebRuntimeSessionTab: vi.fn(),
    destroyWorkspaceWebviews: vi.fn(),
    isWebRuntimeSessionActive: vi.fn(() => true)
  }))

vi.mock('@/runtime/web-runtime-session-tab-lifecycle', () => ({ closeWebRuntimeSessionTab }))
vi.mock('@/runtime/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: vi.fn()
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({ isWebRuntimeSessionActive }))
vi.mock('@/store/slices/browser-webview-cleanup', () => ({ destroyWorkspaceWebviews }))

const closeBrowserTab = vi.fn()
const closeUnifiedTab = vi.fn()
const recordClientHostedBrowserCloseIntents = vi.fn()

function activeBrowserWorkspace(handle: {
  environmentId?: string
  staged?: true
}): Record<string, unknown> {
  return {
    activeTabType: 'browser',
    activeBrowserTabId: 'workspace-1',
    activeWorktreeId: 'wt-1',
    browserTabsByWorktree: { 'wt-1': [{ id: 'workspace-1' }] },
    browserPagesByWorkspace: { 'workspace-1': [{ id: 'page-1', workspaceId: 'workspace-1' }] },
    remoteBrowserPageHandlesByPageId: handle.environmentId
      ? {
          'page-1': {
            environmentId: handle.environmentId,
            remotePageId: 'remote-1',
            ...(handle.staged ? { staged: true } : {})
          }
        }
      : {},
    unifiedTabsByWorktree: {
      'wt-1': [{ id: 'unified-1', contentType: 'browser', entityId: 'workspace-1' }]
    },
    closeBrowserTab,
    closeUnifiedTab,
    recordClientHostedBrowserCloseIntents
  }
}

/** Pageless host mirror ownership comes from its runtime-owned workspace row, not a local page. */
function pagelessHostMirror(): Record<string, unknown> {
  return {
    ...activeBrowserWorkspace({}),
    browserPagesByWorkspace: {},
    worktreesByRepo: {
      'repo-1': [{ id: 'wt-1', repoId: 'repo-1', runtimeOwnerEnvironmentId: 'env-a' }]
    }
  }
}

function requireListener(ref: { current: CloseActiveTabListener | null }): CloseActiveTabListener {
  if (!ref.current) {
    throw new Error('onCloseActiveTab was never registered')
  }
  return ref.current
}

// Runtime connectivity alone does not prove host page ownership; inert host closes leave other tabs standing.
describe('useIpcEvents Close Tab on the active browser tab', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    isWebRuntimeSessionActive.mockReturnValue(true)
  })

  it('closes a host-owned workspace on its runtime and leaves the mirror to tab sync', async () => {
    const listenerRef: { current: CloseActiveTabListener | null } = { current: null }
    await useIpcEventsForCloseRouting({
      closeActiveTabListenerRef: listenerRef,
      getState: () => activeBrowserWorkspace({ environmentId: 'env-a' })
    })

    requireListener(listenerRef)()

    expect(closeWebRuntimeSessionTab).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'unified-1',
      environmentId: 'env-a',
      reason: 'user'
    })
    expect(closeBrowserTab).not.toHaveBeenCalled()
    expect(closeUnifiedTab).not.toHaveBeenCalled()
  })

  // Why: a connected runtime does not make a client-local workspace the host's to close.
  it('tears a local-only workspace down here even while the runtime is connected', async () => {
    const listenerRef: { current: CloseActiveTabListener | null } = { current: null }
    await useIpcEventsForCloseRouting({
      closeActiveTabListenerRef: listenerRef,
      getState: () => activeBrowserWorkspace({})
    })

    requireListener(listenerRef)()

    expect(closeWebRuntimeSessionTab).not.toHaveBeenCalled()
    expect(destroyWorkspaceWebviews).toHaveBeenCalled()
    expect(closeBrowserTab).toHaveBeenCalledWith('workspace-1', undefined)
  })

  // Staged pages lack host identity yet; inert remote close lets the in-flight snapshot recreate them.
  it('unwinds a staged workspace as a cleanup close instead of closing it on the host', async () => {
    const listenerRef: { current: CloseActiveTabListener | null } = { current: null }
    await useIpcEventsForCloseRouting({
      closeActiveTabListenerRef: listenerRef,
      getState: () => activeBrowserWorkspace({ environmentId: 'env-a', staged: true })
    })

    requireListener(listenerRef)()

    expect(closeWebRuntimeSessionTab).not.toHaveBeenCalled()
    expect(closeBrowserTab).toHaveBeenCalledWith('workspace-1', { reason: 'cleanup' })
  })

  // Pageless mirrors need local removal by unified tab ID; host sync has no local page to retract.
  it('removes the mirror tab itself when the host holds no page for it', async () => {
    const listenerRef: { current: CloseActiveTabListener | null } = { current: null }
    await useIpcEventsForCloseRouting({
      closeActiveTabListenerRef: listenerRef,
      getState: pagelessHostMirror
    })

    requireListener(listenerRef)()

    expect(closeWebRuntimeSessionTab).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'unified-1',
      environmentId: 'env-a',
      reason: 'user'
    })
    expect(closeUnifiedTab).toHaveBeenCalledWith('unified-1', undefined)
    expect(closeBrowserTab).not.toHaveBeenCalled()
  })

  // With owner runtime gone, dead host-close requests cannot remove the visible tab.
  it('tears a host-owned workspace down here when its runtime is disconnected', async () => {
    isWebRuntimeSessionActive.mockReturnValue(false)
    const listenerRef: { current: CloseActiveTabListener | null } = { current: null }
    await useIpcEventsForCloseRouting({
      closeActiveTabListenerRef: listenerRef,
      getState: () => activeBrowserWorkspace({ environmentId: 'env-a' })
    })

    requireListener(listenerRef)()

    expect(closeWebRuntimeSessionTab).not.toHaveBeenCalled()
    expect(closeBrowserTab).toHaveBeenCalledWith('workspace-1', undefined)
  })

  it('tears a pageless mirror down here when its runtime is disconnected', async () => {
    isWebRuntimeSessionActive.mockReturnValue(false)
    const listenerRef: { current: CloseActiveTabListener | null } = { current: null }
    await useIpcEventsForCloseRouting({
      closeActiveTabListenerRef: listenerRef,
      getState: pagelessHostMirror
    })

    requireListener(listenerRef)()

    expect(closeWebRuntimeSessionTab).not.toHaveBeenCalled()
    expect(closeUnifiedTab).toHaveBeenCalledWith('unified-1', undefined)
    expect(closeBrowserTab).toHaveBeenCalledWith('workspace-1', undefined)
  })

  // Guest focus can leave the group’s active-type mirror stale; forwarded source IDs must still close the guest’s workspace.
  it('closes the source workspace when the active-tab mirror points at a terminal', async () => {
    const listenerRef: { current: CloseActiveTabListener | null } = { current: null }
    await useIpcEventsForCloseRouting({
      closeActiveTabListenerRef: listenerRef,
      getState: () => ({
        ...activeBrowserWorkspace({}),
        activeTabType: 'terminal',
        activeBrowserTabId: null,
        browserPagesByWorkspace: {
          'workspace-1': [{ id: 'page-1', workspaceId: 'stale-workspace', worktreeId: 'stale-wt' }]
        }
      })
    })

    requireListener(listenerRef)({ sourceId: 'page-1' })

    expect(closeBrowserTab).toHaveBeenCalledWith('workspace-1', undefined)
    expect(destroyWorkspaceWebviews).toHaveBeenCalled()
  })

  // Empty floating-panel fallback must not swallow explicit guest source IDs targeting the main workspace.
  it('closes the source workspace even while an empty floating panel is visible', async () => {
    vi.stubGlobal('document', Object.assign(new EventTarget(), { querySelector: () => ({}) }))
    const listenerRef: { current: CloseActiveTabListener | null } = { current: null }
    await useIpcEventsForCloseRouting({
      closeActiveTabListenerRef: listenerRef,
      getState: () => activeBrowserWorkspace({})
    })

    requireListener(listenerRef)({ sourceId: 'page-1' })

    expect(closeBrowserTab).toHaveBeenCalledWith('workspace-1', undefined)
    expect(destroyWorkspaceWebviews).toHaveBeenCalled()
  })

  it('no-ops on a stale source id instead of closing the ambient active tab', async () => {
    const listenerRef: { current: CloseActiveTabListener | null } = { current: null }
    await useIpcEventsForCloseRouting({
      closeActiveTabListenerRef: listenerRef,
      getState: () => activeBrowserWorkspace({})
    })

    requireListener(listenerRef)({ sourceId: 'page-that-no-longer-exists' })

    expect(closeBrowserTab).not.toHaveBeenCalled()
    expect(closeUnifiedTab).not.toHaveBeenCalled()
    expect(closeWebRuntimeSessionTab).not.toHaveBeenCalled()
  })

  it('no-ops when a source page belongs to no live workspace', async () => {
    const listenerRef: { current: CloseActiveTabListener | null } = { current: null }
    await useIpcEventsForCloseRouting({
      closeActiveTabListenerRef: listenerRef,
      getState: () => ({
        ...activeBrowserWorkspace({}),
        browserPagesByWorkspace: {
          orphan: [{ id: 'orphan-page', workspaceId: 'workspace-1', worktreeId: 'wt-1' }]
        }
      })
    })

    requireListener(listenerRef)({ sourceId: 'orphan-page' })

    expect(closeBrowserTab).not.toHaveBeenCalled()
    expect(closeUnifiedTab).not.toHaveBeenCalled()
    expect(closeWebRuntimeSessionTab).not.toHaveBeenCalled()
  })
})
