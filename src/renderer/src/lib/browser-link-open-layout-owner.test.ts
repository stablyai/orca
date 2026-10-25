import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/browser-focus'
import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'
import { isBrowserPageMountAdmitted } from '@/components/browser-pane/host-guest/browser-page-mount-admission'
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
} from './browser-link-open.test-fixture'
import { captureLinkOpenIntent } from './link-open-intent'
import { beginLinkOpenRequest } from './link-open-request'
import { openWorkspaceBrowserTabForLink } from './workspace-browser-tab-open'
import { openFileInBrowserTab } from './file-preview'
import type { BrowserOpenOutcome } from './browser-link-destination'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
const mocks = vi.hoisted(() => ({ getState: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.getState(), subscribe: mocks.subscribe }
}))
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
  mocks.subscribe.mockImplementation(store.subscribe)
  vi.mocked(requestBrowserFocus).mockClear()
  main = await drawTabsFromMain(store)
  layoutApplyTestTransport.answerWith('pending')
})
afterEach(() => main.close())

function open(surface: 'http' | 'html', explicit = true, background = false) {
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
      ...(background ? { focusOnCreate: false, selectWorktree: false } : {}),
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

function pendingBrowserPageId(): string {
  const pageId = layoutApplyTestTransport.sentOfType('openBrowserTab')[0]?.pageId
  if (!pageId) {
    throw new Error('Expected a pending browser page')
  }
  return pageId
}

it.each([
  ['http', false],
  ['http', true],
  ['html', false],
  ['html', true]
] as const)(
  'waits for main to draw a %s link before reporting and activating its exact page (explicit: %s)',
  async (surface, explicit) => {
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

    const pending = layoutApplyTestTransport.sentOfType('openBrowserTab')[0]!
    const targetGroupId = pending.groupId
    if (explicit) {
      expect(targetGroupId).toBe('a')
    } else {
      expect(pending.split).toMatchObject({ besideGroupId: 'a', direction: 'right' })
    }
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

it('admits a background HTTP page only after main materializes it without activating it', async () => {
  const opening = open('http', false, true)
  const pageId = pendingBrowserPageId()
  expect(isBrowserPageMountAdmitted(pageId)).toBe(false)

  layoutApplyTestTransport.answerWith('apply')
  layoutApplyTestTransport.answerPending()
  await main.settle()

  expect(await opening).toMatchObject({ status: 'opened' })
  expect(isBrowserPageMountAdmitted(pageId)).toBe(true)
  expect(store.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('c')
  expect(requestBrowserFocus).not.toHaveBeenCalled()
})

it('does not activate a link superseded while main was opening its tab', async () => {
  const opening = open('http')
  const pageId = pendingBrowserPageId()
  beginLinkOpenRequest()
  layoutApplyTestTransport.answerWith('apply')
  layoutApplyTestTransport.answerPending()
  await main.settle()

  expect(await opening).toEqual({ status: 'superseded' })
  await main.settle()
  expect(store.getState().browserTabsByWorktree[WORKSPACE] ?? []).toEqual([])
  expect(store.getState().browserPagesByWorkspace).toEqual({})
  expect(
    store.getState().unifiedTabsByWorktree[WORKSPACE]?.some((tab) => tab.contentType === 'browser')
  ).toBe(false)
  expect(store.getState().recentlyClosedBrowserTabsByWorktree[WORKSPACE] ?? []).toEqual([])
  expect(store.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('c')
  expect(isBrowserPageMountAdmitted(pageId)).toBe(false)
  expect(requestBrowserFocus).not.toHaveBeenCalled()
})

it.each(['workspace', 'view', 'view-return'] as const)(
  'retains a tab without revealing or focusing it after navigation during layout acknowledgement: %s',
  async (navigation) => {
    const opening = open('http', false)
    const pageId = pendingBrowserPageId()
    if (navigation === 'workspace') {
      store.getState().setActiveWorktree(null)
    } else {
      const previousView = store.getState().activeView
      store.getState().setActiveView('skills')
      if (navigation === 'view-return') {
        store.getState().setActiveView(previousView)
      }
    }
    const selected = store.getState()
    layoutApplyTestTransport.answerWith('apply')
    layoutApplyTestTransport.answerPending()
    await main.settle()

    expect(await opening).toMatchObject({ status: 'opened' })
    const state = store.getState()
    expect(state.browserTabsByWorktree[WORKSPACE]).toHaveLength(1)
    expect(state.activeWorktreeId).toBe(selected.activeWorktreeId)
    expect(state.activeView).toBe(selected.activeView)
    expect(state.activeGroupIdByWorktree[WORKSPACE]).toBe('c')
    expect(state.groupsByWorktree[WORKSPACE]?.find((group) => group.id === 'b')?.activeTabId).toBe(
      'terminal-b'
    )
    expect(isBrowserPageMountAdmitted(pageId)).toBe(true)
    expect(requestBrowserFocus).not.toHaveBeenCalled()
  }
)

it('does not activate a link whose owner changed while main was opening its tab', async () => {
  const opening = open('http')
  const pageId = pendingBrowserPageId()
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
  await main.settle()
  expect(store.getState().browserTabsByWorktree[WORKSPACE] ?? []).toEqual([])
  expect(store.getState().browserPagesByWorkspace).toEqual({})
  expect(
    store.getState().unifiedTabsByWorktree[WORKSPACE]?.some((tab) => tab.contentType === 'browser')
  ).toBe(false)
  expect(store.getState().recentlyClosedBrowserTabsByWorktree[WORKSPACE] ?? []).toEqual([])
  expect(store.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('c')
  expect(isBrowserPageMountAdmitted(pageId)).toBe(false)
  expect(requestBrowserFocus).not.toHaveBeenCalled()
})

it('reports failure when main refuses the browser creation', async () => {
  const opening = open('http')
  const pageId = pendingBrowserPageId()
  layoutApplyTestTransport.answerWith({ refuse: 'workspace_not_found' })
  layoutApplyTestTransport.answerPending()
  await main.settle()

  expect(await opening).toEqual({ status: 'failed' })
  expect(store.getState().browserPagesByWorkspace).toEqual({})
  expect(isBrowserPageMountAdmitted(pageId)).toBe(false)
  expect(requestBrowserFocus).not.toHaveBeenCalled()
})
