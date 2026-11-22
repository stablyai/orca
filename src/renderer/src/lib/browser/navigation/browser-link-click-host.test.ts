import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStoreCascadesMockApi } from '@/store/testing/app-store-cascade-api.test-fixture'
import '@/store/testing/app-store-test-fixture'
import { beginLinkOpenRequest } from '../../links/link-open-request'
import {
  createBrowserLinkTestStore,
  WORKSPACE,
  URL_TO_OPEN
} from './browser-link-open.test-fixture'
import type { BrowserLinkTestStore } from './browser-link-open.test-fixture'
import type { BrowserLinkOpenContext } from './browser-link-destination'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { openWorkspaceBrowserTabForLink } from '../workspace/workspace-browser-tab-open'
import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/input/browser-focus'

const mocks = vi.hoisted(() => ({ getState: vi.fn() }))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => mocks.getState() } }))
vi.mock('@/components/browser-pane/host-guest/input/browser-focus', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserFocusModule>()),
  requestBrowserFocus: vi.fn()
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))
createStoreCascadesMockApi()
let store: BrowserLinkTestStore

beforeEach(() => {
  store = createBrowserLinkTestStore()
  mocks.getState.mockImplementation(() => store.getState())
})

function chooserContext(clickHostId: ExecutionHostId | null): BrowserLinkOpenContext {
  return {
    linkIntent: null,
    isCurrentRequest: beginLinkOpenRequest(),
    clickHostId,
    requireClickHost: true
  }
}

function open(linkContext: BrowserLinkOpenContext) {
  return openWorkspaceBrowserTabForLink({
    workspaceId: WORKSPACE,
    url: URL_TO_OPEN,
    intent: { kind: 'url' },
    linkContext
  })
}

function browserTabGroups(): string[] {
  return (store.getState().unifiedTabsByWorktree[WORKSPACE] ?? [])
    .filter((tab) => tab.contentType === 'browser')
    .map((tab) => tab.groupId)
}

function moveWorkspaceToAnotherHost(): void {
  const host = 'ssh:other'
  store.setState((state) => ({
    repos: state.repos.map((repo) => ({ ...repo, executionHostId: host, connectionId: 'other' })),
    worktreesByRepo: {
      repo1: state.worktreesByRepo.repo1!.map((worktree) => ({ ...worktree, hostId: host }))
    },
    activeWorkspaceExecutionHostId: host
  }))
}

describe('chooser actions with no source tab', () => {
  it('place the tab exactly where the uncaptured open did', async () => {
    const before = await open({ linkIntent: null })
    const placed = browserTabGroups()
    store = createBrowserLinkTestStore()
    const after = await open(chooserContext(LOCAL_EXECUTION_HOST_ID))
    expect([before.status, after.status]).toEqual(['opened', 'opened'])
    expect(browserTabGroups()).toEqual(placed)
  })

  it('refuse before creating a tab when the workspace moved to another host after the click', async () => {
    const context = chooserContext(LOCAL_EXECUTION_HOST_ID)
    moveWorkspaceToAnotherHost()
    expect(await open(context)).toEqual({ status: 'refused' })
    expect(browserTabGroups()).toEqual([])
  })

  it('refuse when the click had no qualified host', async () => {
    expect(await open(chooserContext(null))).toEqual({ status: 'refused' })
    expect(browserTabGroups()).toEqual([])
  })

  it('stand down when a newer link open superseded the click', async () => {
    const context = chooserContext(LOCAL_EXECUTION_HOST_ID)
    beginLinkOpenRequest()
    expect(await open(context)).toEqual({ status: 'superseded' })
    expect(browserTabGroups()).toEqual([])
  })
})
