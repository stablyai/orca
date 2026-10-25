import { toast } from 'sonner'
import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/browser-focus'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../shared/constants'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/store-test-helpers'
import { canOfferHttpLinkGroupAction } from './http-link-in-group-availability'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import { openWorkspaceBrowserTabForLink } from './workspace-browser-tab-open'
import { openRoutedHttpLink } from './http-link-destinations'
import {
  registerHttpLinkStoreAccessor,
  registerWorkspaceHttpLinkBrowserOpener
} from './http-link-routing'
import { nativeChatLinkActions } from '@/components/native-chat/native-chat-link-target-actions'
import {
  createBrowserLinkTestStore,
  WORKSPACE,
  URL_TO_OPEN,
  type BrowserLinkTestStore
} from './browser-link-open.test-fixture'
import type { BrowserOpenOutcome } from './browser-link-destination'

const mocks = vi.hoisted(() => ({ getState: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.getState() } }))
vi.mock('@/components/browser-pane/host-guest/browser-focus', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserFocusModule>()),
  requestBrowserFocus: vi.fn()
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))
createStoreCascadesMockApi()
let store: BrowserLinkTestStore
let outcomes: BrowserOpenOutcome[]
beforeEach(() => {
  store = createBrowserLinkTestStore()
  outcomes = []
  mocks.getState.mockImplementation(() => store.getState())
  registerHttpLinkStoreAccessor(() => store.getState())
  registerWorkspaceHttpLinkBrowserOpener(async (request) => {
    if (request.linkContext) {
      outcomes.push(
        await openWorkspaceBrowserTabForLink({ ...request, linkContext: request.linkContext })
      )
    }
  })
})
afterEach(() => {
  registerWorkspaceHttpLinkBrowserOpener(null)
})

async function settle() {
  for (let i = 0; i < 15; i++) {
    await Promise.resolve()
  }
}

it.each([false, true])(
  'opens hostless legacy links relative to their source (explicit: %s)',
  async (explicit) => {
    store.setState((state) => ({
      unifiedTabsByWorktree: {
        [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
          ...tab,
          executionHostId: undefined
        }))
      }
    }))
    expect(
      canOfferHttpLinkGroupAction(store.getState(), {
        workspaceId: WORKSPACE,
        sourceTabId: 'source',
        sourceOwner: { kind: 'local' },
        url: URL_TO_OPEN
      })
    ).toBe(true)
    openRoutedHttpLink(URL_TO_OPEN, {
      worktreeId: WORKSPACE,
      sourceTabId: 'source',
      sourceOwner: { kind: 'local' },
      forceDestination: 'orca',
      openInSourceGroup: explicit
    })
    await settle()
    expect(outcomes).toMatchObject([
      { status: 'opened', ...(explicit ? { result: { groupId: 'a' } } : {}) }
    ])
  }
)

it('captures the link owner before an asynchronous preference decision and follows its current group', async () => {
  let resolvePreference: ((value: boolean) => void) | undefined
  const preference = new Promise<boolean>((resolve) => {
    resolvePreference = resolve
  })
  openRoutedHttpLink(URL_TO_OPEN, {
    worktreeId: WORKSPACE,
    sourceTabId: 'source',
    sourceOwner: { kind: 'local' },
    requestOpenLinksInAppPreference: () => preference
  })
  store.setState((state) => ({
    unifiedTabsByWorktree: {
      [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) =>
        tab.id === 'source' ? { ...tab, groupId: 'b' } : tab
      )
    },
    activeGroupIdByWorktree: { [WORKSPACE]: 'a' }
  }))
  store.setState({ settings: { ...getDefaultSettings('/home/test'), openLinksInApp: true } })
  resolvePreference?.(true)
  await settle()
  expect(outcomes).toMatchObject([{ status: 'opened' }])
  expect(store.getState().layoutByWorktree[WORKSPACE]).toMatchObject({
    second: { first: { type: 'split', first: { groupId: 'b' } } }
  })
})

it('a newer activation suppresses an older pending preference decision', async () => {
  let resolvePreference: ((value: boolean) => void) | undefined
  const preference = new Promise<boolean>((resolve) => {
    resolvePreference = resolve
  })
  openRoutedHttpLink(URL_TO_OPEN, {
    worktreeId: WORKSPACE,
    sourceTabId: 'source',
    requestOpenLinksInAppPreference: () => preference
  })
  openRoutedHttpLink('https://second.example/', {
    worktreeId: WORKSPACE,
    sourceTabId: 'source',
    forceDestination: 'orca'
  })
  resolvePreference?.(true)
  await settle()
  expect(outcomes).toHaveLength(1)
  expect(store.getState().browserTabsByWorktree[WORKSPACE]?.[0]?.url).toBe(
    'https://second.example/'
  )
})

it('the native chat context menu pins the owning tab when the action runs, even with a system-browser preference', async () => {
  const actions = nativeChatLinkActions(URL_TO_OPEN, {
    worktreeId: WORKSPACE,
    worktreePath: '/repo',
    runtimeEnvironmentId: null,
    sourceTabId: 'source'
  })
  const row = actions?.secondaryActions?.find((action) => action.label === 'Open in this group')
  expect(row).toBeDefined()
  store.setState((state) => ({
    unifiedTabsByWorktree: {
      [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) =>
        tab.id === 'source' ? { ...tab, groupId: 'b' } : tab
      )
    }
  }))
  row?.run()
  await settle()
  expect(outcomes).toMatchObject([{ status: 'opened', result: { groupId: 'b' } }])
})

it('refuses a stale explicit chat action when its source closed before activation', async () => {
  const actions = nativeChatLinkActions(URL_TO_OPEN, {
    worktreeId: WORKSPACE,
    worktreePath: '/repo',
    runtimeEnvironmentId: null,
    sourceTabId: 'source'
  })
  const action = actions?.secondaryActions?.find((row) => row.label === 'Open in this group')
  expect(action).toBeDefined()
  store.setState((state) => ({
    unifiedTabsByWorktree: {
      [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.filter((tab) => tab.id !== 'source')
    }
  }))
  action?.run()
  await settle()
  expect(outcomes).toEqual([])
  expect(store.getState().browserPagesByWorkspace).toEqual({})
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Couldn't open"))
})

it.each([false, true])(
  'opens floating HTTP links through the managed route (explicit: %s)',
  async (explicit) => {
    const floating = FLOATING_TERMINAL_WORKTREE_ID
    store.setState((state) => ({
      groupsByWorktree: {
        ...state.groupsByWorktree,
        [floating]: ['left', 'right'].map((id) =>
          makeTabGroup({
            id,
            worktreeId: floating,
            activeTabId: id === 'left' ? 'floating-source' : null,
            tabOrder: id === 'left' ? ['floating-source'] : []
          })
        )
      },
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        [floating]: [
          makeUnifiedTab({
            id: 'floating-source',
            worktreeId: floating,
            groupId: 'left',
            executionHostId: 'local',
            contentType: 'terminal'
          })
        ]
      },
      layoutByWorktree: {
        ...state.layoutByWorktree,
        [floating]: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'left' },
          second: { type: 'leaf', groupId: 'right' }
        }
      }
    }))
    expect(
      canOfferHttpLinkGroupAction(store.getState(), {
        workspaceId: floating,
        sourceTabId: 'floating-source',
        sourceOwner: { kind: 'local' },
        url: URL_TO_OPEN
      })
    ).toBe(true)
    openRoutedHttpLink(URL_TO_OPEN, {
      worktreeId: floating,
      sourceTabId: 'floating-source',
      sourceOwner: { kind: 'local' },
      forceDestination: 'orca',
      openInSourceGroup: explicit
    })
    await settle()
    expect(outcomes).toMatchObject([
      {
        status: 'opened',
        result: {
          worktreeId: floating,
          executionHostId: 'local',
          ...(explicit ? { groupId: 'left' } : {})
        }
      }
    ])
    if (!explicit) {
      expect(store.getState().layoutByWorktree[floating]).toMatchObject({
        first: { type: 'split', first: { groupId: 'left' } }
      })
    }
    expect(store.getState().activeWorktreeId).toBe(WORKSPACE)
    expect(store.getState().activeWorkspaceExecutionHostId).toBe('local')
    expect(store.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('c')
    expect(store.getState().browserTabsByWorktree[WORKSPACE] ?? []).toEqual([])
  }
)
