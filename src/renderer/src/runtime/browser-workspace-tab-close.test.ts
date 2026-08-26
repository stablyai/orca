import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import {
  consumeBrowserAddressBarEditSession,
  saveBrowserAddressBarEditSession
} from '@/components/browser-pane/assemble-chrome/browser-address-bar-edit-session'
import {
  consumeBrowserPageDeferredNavigation,
  deferBrowserPageNavigation
} from '@/components/browser-pane/navigate/browser-page-deferred-navigation'

const {
  closeWebRuntimeSessionTab,
  isWebRuntimeSessionActive,
  destroyWorkspaceWebviews,
  storeState
} = vi.hoisted(() => ({
  closeWebRuntimeSessionTab: vi.fn(async () => 'applied' as string),
  isWebRuntimeSessionActive: vi.fn(() => true),
  destroyWorkspaceWebviews: vi.fn(),
  storeState: {
    current: {} as Record<string, unknown>
  }
}))

vi.mock('./web-runtime-session', () => ({ closeWebRuntimeSessionTab, isWebRuntimeSessionActive }))
vi.mock('@/store/slices/browser-webview-cleanup', () => ({ destroyWorkspaceWebviews }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState.current } }))

import { closeBrowserWorkspaceTabOnHosts } from './browser-workspace-tab-close'

const WORKSPACE_ID = 'workspace-a'
const PAGE_ID = 'page-a'
const OTHER_WORKSPACE_ID = 'workspace-b'
const OTHER_PAGE_ID = 'page-b'

function browserPage(
  id: string,
  workspaceId: string
): AppState['browserPagesByWorkspace'][string][number] {
  return { id, workspaceId } as AppState['browserPagesByWorkspace'][string][number]
}

const recordClientHostedBrowserCloseIntents = vi.fn()

function closeState(
  staged: boolean,
  overrides: Partial<AppState> = {}
): Pick<
  AppState,
  | 'browserPagesByWorkspace'
  | 'remoteBrowserPageHandlesByPageId'
  | 'recordClientHostedBrowserCloseIntents'
> {
  return {
    recordClientHostedBrowserCloseIntents,
    browserPagesByWorkspace: {
      [WORKSPACE_ID]: [browserPage(PAGE_ID, WORKSPACE_ID)],
      // Why a second workspace is always in the store here: a release that walks every workspace's
      // pages reads identically to one scoped to the closing tab until something else is open.
      [OTHER_WORKSPACE_ID]: [browserPage(OTHER_PAGE_ID, OTHER_WORKSPACE_ID)]
    },
    remoteBrowserPageHandlesByPageId: {
      [PAGE_ID]: {
        environmentId: 'environment-a',
        remotePageId: 'remote-page-a',
        ...(staged ? { staged: true } : {})
      },
      [OTHER_PAGE_ID]: { environmentId: 'environment-a', remotePageId: 'remote-page-b' }
    },
    ...overrides
  }
}

function closeWorkspace(staged: boolean, overrides: Partial<AppState> = {}): void {
  closeBrowserWorkspaceTabOnHosts({
    state: closeState(staged, overrides),
    worktreeId: 'worktree-a',
    workspaceId: WORKSPACE_ID,
    visibleTabId: 'tab-a',
    focusedEnvironmentId: 'environment-a'
  })
}

/** A client-hosted page: the only kind whose close the runtime can outlive and undo. */
function clientHostedHandles(): Partial<AppState> {
  return {
    remoteBrowserPageHandlesByPageId: {
      [PAGE_ID]: {
        environmentId: 'environment-a',
        remotePageId: 'remote-page-a',
        placement: {
          kind: 'client',
          browserHostClientId: 'host-a',
          browserHostGeneration: 1,
          pageHostGeneration: 1
        }
      }
    } as AppState['remoteBrowserPageHandlesByPageId']
  }
}

/** One workspace whose pages were opened against two different runtime environments. */
function twoOwnerClientHostedHandles(): Partial<AppState> {
  const placement = {
    kind: 'client' as const,
    browserHostClientId: 'host-a',
    browserHostGeneration: 1,
    pageHostGeneration: 1
  }
  return {
    browserPagesByWorkspace: {
      [WORKSPACE_ID]: [browserPage(PAGE_ID, WORKSPACE_ID), browserPage('page-c', WORKSPACE_ID)]
    } as AppState['browserPagesByWorkspace'],
    remoteBrowserPageHandlesByPageId: {
      [PAGE_ID]: { environmentId: 'environment-a', remotePageId: 'remote-page-a', placement },
      'page-c': { environmentId: 'environment-b', remotePageId: 'remote-page-c', placement }
    } as AppState['remoteBrowserPageHandlesByPageId']
  }
}

function liveStore(): Record<string, unknown> {
  return {
    browserTabsByWorktree: { 'worktree-a': [{ id: WORKSPACE_ID }] },
    browserPagesByWorkspace: { [WORKSPACE_ID]: [browserPage(PAGE_ID, WORKSPACE_ID)] },
    unifiedTabsByWorktree: {
      'worktree-a': [{ id: 'unified-a', contentType: 'browser', entityId: WORKSPACE_ID }]
    },
    closeBrowserTab: vi.fn(),
    closeUnifiedTab: vi.fn()
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.clearAllMocks()
  isWebRuntimeSessionActive.mockReturnValue(true)
  closeWebRuntimeSessionTab.mockResolvedValue('applied')
  storeState.current = liveStore()
})

afterEach(() => {
  for (const pageId of [PAGE_ID, OTHER_PAGE_ID]) {
    consumeBrowserAddressBarEditSession(pageId)
    consumeBrowserPageDeferredNavigation(pageId)
  }
})

describe('closeBrowserWorkspaceTabOnHosts releases parked page chrome', () => {
  // Why staged specifically: a URL only gets parked because the host had not minted the page yet,
  // and that same tab is the one whose X unwinds a create the user gave up on.
  it('drops a URL submitted against a staged page that is then closed', () => {
    deferBrowserPageNavigation(PAGE_ID, 'https://example.internal/never-arrived')

    closeWorkspace(true)

    expect(consumeBrowserPageDeferredNavigation(PAGE_ID)).toBeNull()
  })

  it('drops an edit parked by a page the user closed mid-typing', () => {
    saveBrowserAddressBarEditSession(PAGE_ID, {
      draft: 'half-typed.internal',
      selection: { start: 4, end: 4, direction: 'none' },
      suggestionsOpen: true,
      preview: null
    })

    closeWorkspace(false)

    expect(consumeBrowserAddressBarEditSession(PAGE_ID)).toBeNull()
  })

  it('leaves the chrome parked by a browser tab the user did not close', () => {
    saveBrowserAddressBarEditSession(OTHER_PAGE_ID, {
      draft: 'still-typing.internal',
      selection: { start: 5, end: 5, direction: 'none' },
      suggestionsOpen: true,
      preview: null
    })
    deferBrowserPageNavigation(OTHER_PAGE_ID, 'https://example.internal/other-tab')

    closeWorkspace(false)

    expect(consumeBrowserAddressBarEditSession(OTHER_PAGE_ID)?.draft).toBe('still-typing.internal')
    expect(consumeBrowserPageDeferredNavigation(OTHER_PAGE_ID)).toBe(
      'https://example.internal/other-tab'
    )
  })
})

describe('closeBrowserWorkspaceTabOnHosts when the owning host cannot settle the close', () => {
  it('tears the tab down here once every owner disavows the page', async () => {
    closeWebRuntimeSessionTab.mockResolvedValue('unknown-tab')

    closeWorkspace(false, clientHostedHandles())
    await settle()

    expect(destroyWorkspaceWebviews).toHaveBeenCalledWith(expect.anything(), WORKSPACE_ID)
    expect(storeState.current.closeBrowserTab).toHaveBeenCalledWith(WORKSPACE_ID)
    expect(storeState.current.closeUnifiedTab).toHaveBeenCalledWith('unified-a')
    // Nothing to replay: the host answered that it has no such tab, so the close is settled.
    expect(recordClientHostedBrowserCloseIntents).toHaveBeenCalledWith([])
  })

  it('leaves the teardown to tab sync when the host still knows the page', async () => {
    closeWebRuntimeSessionTab.mockResolvedValue('applied')

    closeWorkspace(false, clientHostedHandles())
    await settle()

    expect(destroyWorkspaceWebviews).not.toHaveBeenCalled()
    expect(storeState.current.closeBrowserTab).not.toHaveBeenCalled()
  })

  it('leaves the tab standing while any owner still knows the page', async () => {
    // Two hosts hold pages of this one workspace. The one that still knows it removes the mirror
    // through tab sync, so tearing down here on the other one's disavowal would race that.
    closeWebRuntimeSessionTab.mockResolvedValueOnce('unknown-tab').mockResolvedValueOnce('applied')

    closeWorkspace(false, twoOwnerClientHostedHandles())
    await settle()

    expect(closeWebRuntimeSessionTab).toHaveBeenCalledTimes(2)
    expect(destroyWorkspaceWebviews).not.toHaveBeenCalled()
    expect(storeState.current.closeBrowserTab).not.toHaveBeenCalled()
  })

  it('records a replayable close when the host could not be asked', async () => {
    closeWebRuntimeSessionTab.mockResolvedValue('failed')

    closeWorkspace(false, clientHostedHandles())
    await settle()

    expect(recordClientHostedBrowserCloseIntents).toHaveBeenCalledWith([
      {
        environmentId: 'environment-a',
        browserPageId: 'remote-page-a',
        worktreeId: 'worktree-a'
      }
    ])
    // A host that could not answer is not a host that forgot: the tab stays for the retraction.
    expect(storeState.current.closeBrowserTab).not.toHaveBeenCalled()
  })

  it('records a replayable close when every owning environment is unreachable', () => {
    isWebRuntimeSessionActive.mockReturnValue(false)

    closeWorkspace(false, clientHostedHandles())

    expect(closeWebRuntimeSessionTab).not.toHaveBeenCalled()
    expect(recordClientHostedBrowserCloseIntents).toHaveBeenCalledWith([
      {
        environmentId: 'environment-a',
        browserPageId: 'remote-page-a',
        worktreeId: 'worktree-a'
      }
    ])
  })

  it('records nothing for a server-placed page, which dies with its runtime anyway', () => {
    isWebRuntimeSessionActive.mockReturnValue(false)

    closeWorkspace(false)

    expect(recordClientHostedBrowserCloseIntents).toHaveBeenCalledWith([])
  })
})
