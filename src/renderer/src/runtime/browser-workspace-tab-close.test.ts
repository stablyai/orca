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

vi.mock('./web-runtime-session-tab-lifecycle', () => ({ closeWebRuntimeSessionTab }))
vi.mock('./web-runtime-session-environment', () => ({ isWebRuntimeSessionActive }))
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
      // Keep another workspace open or an incorrectly unscoped page release passes too.
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
  // Parked URLs belong to staged, not-yet-host-minted pages; closing must unwind their pending creation.
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
