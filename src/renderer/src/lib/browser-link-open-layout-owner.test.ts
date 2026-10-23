import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/browser-focus'
import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import {
  createBrowserLinkTestStore,
  WORKSPACE,
  URL_TO_OPEN,
  type BrowserLinkTestStore
} from './browser-link-open-test-harness'
import { captureLinkOpenIntent } from './link-open-intent'
import { beginLinkOpenRequest } from './link-open-request'
import { openWorkspaceBrowserTabForLink } from './workspace-browser-tab-open'
import { openFileInBrowserTab } from './file-preview'
import type { BrowserOpenOutcome } from './browser-link-destination'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
const mocks = vi.hoisted(() => ({ getState: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.getState() } }))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
vi.mock('@/components/browser-pane/host-guest/browser-focus', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserFocusModule>()),
  requestBrowserFocus: vi.fn()
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))
createStoreCascadesMockApi()
let store: BrowserLinkTestStore
let main: TabsDrawnFromMain

beforeEach(async () => {
  store = createBrowserLinkTestStore()
  store.setState({
    tabsByWorktree: {
      [WORKSPACE]: store.getState().unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
        id: tab.entityId,
        ptyId: null,
        worktreeId: WORKSPACE,
        title: 'Terminal',
        customTitle: null,
        color: null,
        sortOrder: tab.sortOrder,
        createdAt: tab.createdAt
      }))
    }
  })
  mocks.getState.mockImplementation(() => store.getState())
  vi.mocked(requestBrowserFocus).mockClear()
  main = await drawTabsFromMain(store)
  layoutApplyTestTransport.answerWith('pending')
})
afterEach(() => main.close())

function open(surface: 'http' | 'html', explicit = true) {
  const linkContext = {
    linkIntent: captureLinkOpenIntent(store.getState(), WORKSPACE, 'source', {
      explicitSourceGroup: explicit
    }),
    isCurrentRequest: beginLinkOpenRequest()
  }
  if (surface === 'http') {
    return openWorkspaceBrowserTabForLink({
      workspaceId: WORKSPACE,
      url: URL_TO_OPEN,
      intent: { kind: 'url' },
      linkContext
    })
  }
  return new Promise<BrowserOpenOutcome>((resolve) =>
    openFileInBrowserTab({
      worktreeId: WORKSPACE,
      filePath: '/repo/index.html',
      linkContext,
      onLinkOutcome: resolve
    })
  )
}

it.each([
  ['http', false],
  ['http', true],
  ['html', false],
  ['html', true]
] as const)(
  'waits for main to draw a %s link before reporting and activating its exact page (explicit: %s)',
  async (surface, explicit) => {
    const targetGroupId = explicit ? 'a' : 'b'
    const reported = vi.fn()
    const opening = open(surface, explicit).then((outcome) => {
      reported(outcome)
      return outcome
    })
    await Promise.resolve()
    expect(reported).not.toHaveBeenCalled()
    expect(store.getState().browserPagesByWorkspace).toEqual({})
    expect(store.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('c')
    expect(requestBrowserFocus).not.toHaveBeenCalled()

    layoutApplyTestTransport.answerWith('apply')
    layoutApplyTestTransport.answerPending()
    await main.settle()
    const outcome = await opening
    expect(outcome).toMatchObject({
      status: 'opened',
      result: { worktreeId: WORKSPACE, groupId: targetGroupId }
    })
    if (outcome.status !== 'opened') {
      throw new Error('Expected a materialized browser link')
    }
    const { result } = outcome
    const state = store.getState()
    expect(
      state.groupsByWorktree[WORKSPACE]?.find((group) => group.id === targetGroupId)?.activeTabId
    ).toBe(result.unifiedTabId)
    expect(state.activeGroupIdByWorktree[WORKSPACE]).toBe(targetGroupId)
    expect(state.activeBrowserTabId).toBe(result.browserWorkspaceId)
    expect(
      state.browserTabsByWorktree[WORKSPACE]?.find((tab) => tab.id === result.browserWorkspaceId)
        ?.activePageId
    ).toBe(result.browserPageId)
    expect(requestBrowserFocus).toHaveBeenCalledExactlyOnceWith({
      pageId: result.browserPageId,
      target: 'webview'
    })
  }
)

it('does not activate a link superseded while main was opening its tab', async () => {
  const opening = open('http')
  beginLinkOpenRequest()
  layoutApplyTestTransport.answerWith('apply')
  layoutApplyTestTransport.answerPending()
  await main.settle()

  expect(await opening).toEqual({ status: 'superseded' })
  expect(store.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('c')
  expect(requestBrowserFocus).not.toHaveBeenCalled()
})

it('does not activate a link whose owner changed while main was opening its tab', async () => {
  const opening = open('http')
  store.setState((state) => ({
    worktreesByRepo: {
      repo1: state.worktreesByRepo.repo1!.map((worktree) => ({
        ...worktree,
        hostId: 'ssh:changed'
      }))
    }
  }))
  layoutApplyTestTransport.answerWith('apply')
  layoutApplyTestTransport.answerPending()
  await main.settle()

  expect(await opening).toEqual({ status: 'refused' })
  expect(store.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('c')
  expect(requestBrowserFocus).not.toHaveBeenCalled()
})

it('reports failure when main refuses the browser creation', async () => {
  const opening = open('http')
  layoutApplyTestTransport.answerWith({ refuse: 'workspace_not_found' })
  layoutApplyTestTransport.answerPending()
  await main.settle()

  expect(await opening).toEqual({ status: 'failed' })
  expect(store.getState().browserPagesByWorkspace).toEqual({})
  expect(requestBrowserFocus).not.toHaveBeenCalled()
})
