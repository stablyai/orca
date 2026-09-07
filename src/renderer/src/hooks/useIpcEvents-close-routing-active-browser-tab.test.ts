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

vi.mock('@/runtime/web-runtime-session', () => ({
  closeWebRuntimeSessionTab,
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebRuntimeSessionActive
}))
vi.mock('@/store/slices/browser-webview-cleanup', () => ({ destroyWorkspaceWebviews }))

const closeBrowserTab = vi.fn()
const closeUnifiedTab = vi.fn()
const recordClientHostedBrowserCloseIntents = vi.fn()

/** One active browser workspace, optionally held under a handle the host has not published yet. */
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

/**
 * The host's own browser tab, mirrored here with no page of its own. The worktree row names the
 * runtime, which is the only thing that makes such a mirror closable at all.
 */
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

// Why: the menu's Close Tab used to answer ownership with "is this worktree's runtime connected",
// which is a different question from "does the host hold this workspace's pages" — and it fired an
// inert session.tabs.close at everything else.
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
      tabId: 'workspace-1',
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

  // Why: a staged page names a runtime that has not minted it yet, so the host close is inert and
  // the in-flight create's snapshot puts the tab back.
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

  // Why: a pageless mirror is the only shape whose visible tab this renderer must remove itself —
  // the host has no page here to retract it through tab sync. The tab to remove is the unified
  // tab's own id, not the workspace id it points at.
  it('removes the mirror tab itself when the host holds no page for it', async () => {
    const listenerRef: { current: CloseActiveTabListener | null } = { current: null }
    await useIpcEventsForCloseRouting({
      closeActiveTabListenerRef: listenerRef,
      getState: pagelessHostMirror
    })

    requireListener(listenerRef)()

    expect(closeWebRuntimeSessionTab).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'workspace-1',
      environmentId: 'env-a',
      reason: 'user'
    })
    expect(closeUnifiedTab).toHaveBeenCalledWith('unified-1')
    expect(closeBrowserTab).not.toHaveBeenCalled()
  })

  // Why: with the owning runtime gone there is nobody to close on, and an X that only fans a dead
  // host close leaves the tab standing.
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
    expect(closeUnifiedTab).not.toHaveBeenCalled()
    expect(closeBrowserTab).toHaveBeenCalledWith('workspace-1', undefined)
  })

  // Why: in split layouts the activeTabType mirror can say 'terminal' while a browser guest holds
  // focus (guest focus never reaches the group's focus-capture); the guest-forwarded source id must
  // close the guest's own workspace anyway.
  it('closes the source workspace when the active-tab mirror points at a terminal', async () => {
    const listenerRef: { current: CloseActiveTabListener | null } = { current: null }
    await useIpcEventsForCloseRouting({
      closeActiveTabListenerRef: listenerRef,
      getState: () => ({
        ...activeBrowserWorkspace({}),
        activeTabType: 'terminal',
        activeBrowserTabId: null,
        browserPagesByWorkspace: {
          // Ownership comes from the canonical maps, not denormalized page fields.
          'workspace-1': [{ id: 'page-1', workspaceId: 'stale-workspace', worktreeId: 'stale-wt' }]
        }
      })
    })

    requireListener(listenerRef)({ sourceId: 'page-1' })

    expect(closeBrowserTab).toHaveBeenCalledWith('workspace-1', undefined)
    expect(destroyWorkspaceWebviews).toHaveBeenCalled()
  })

  // Why: an open-but-empty floating panel is the ambient close fallback only; a guest-forwarded
  // source id names a main-workspace target and must not be swallowed by the panel toggle.
  it('closes the source workspace even while an empty floating panel is visible', async () => {
    vi.stubGlobal('document', { querySelector: () => ({}) })
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
