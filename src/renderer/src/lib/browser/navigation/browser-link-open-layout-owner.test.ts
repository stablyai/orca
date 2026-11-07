import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/browser-focus'
import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'
import { isBrowserPageMountAdmitted } from '@/components/browser-pane/host-guest/browser-page-mount-admission'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
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
import { captureLinkOpenIntent } from '../../link-open-intent'
import { beginLinkOpenRequest } from '../../link-open-request'
import { openWorkspaceBrowserTabForLink } from '../workspace/workspace-browser-tab-open'
import { openFileInBrowserTab } from '../../file-preview'
import type { BrowserOpenOutcome } from './browser-link-destination'

vi.mock('../../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
const mocks = vi.hoisted(() => ({ getState: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/store/index', () => ({
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
  vi.mocked(toast.error).mockClear()
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
    const groupCount = store.getState().groupsByWorktree[WORKSPACE]!.length
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
    expect(targetGroupId).toBe(explicit ? 'a' : 'b')
    expect(pending.split).toBeUndefined()
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
    expect(state.groupsByWorktree[WORKSPACE]).toHaveLength(groupCount)
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

async function createRemoteDocPreview() {
  layoutApplyTestTransport.answerWith('apply')
  const preview = store.getState().createBrowserTab(WORKSPACE, '', {
    targetGroupId: 'b',
    browserRuntimeEnvironmentId: null,
    docLocation: { kind: 'workspace-doc', worktreeId: WORKSPACE, filePath: '/repo/index.html' },
    activate: false
  })
  await main.settle()
  store.getState().closeUnifiedTab('terminal-b')
  await main.settle()
  store.setState((state) => ({
    repos: state.repos.map((repo) => ({
      ...repo,
      connectionId: 'preview-owner',
      executionHostId: 'ssh:preview-owner'
    })),
    worktreesByRepo: {
      repo1: state.worktreesByRepo.repo1!.map((worktree) => ({
        ...worktree,
        hostId: 'ssh:preview-owner'
      }))
    },
    activeWorkspaceExecutionHostId: 'ssh:preview-owner',
    unifiedTabsByWorktree: {
      [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
        ...tab,
        executionHostId: 'ssh:preview-owner'
      }))
    }
  }))
  layoutApplyTestTransport.answerWith('pending')
  return preview
}

it('relocates a reused document preview through main and collapses its emptied group', async () => {
  const preview = await createRemoteDocPreview()
  openFileInBrowserTab({ worktreeId: WORKSPACE, filePath: '/repo/index.html', targetGroupId: 'a' })
  expect(
    store.getState().unifiedTabsByWorktree[WORKSPACE]?.find((tab) => tab.entityId === preview.id)
  ).toMatchObject({ groupId: 'b' })

  layoutApplyTestTransport.answerWith('apply')
  layoutApplyTestTransport.answerPending()
  await main.settle()

  const state = store.getState()
  expect(
    state.unifiedTabsByWorktree[WORKSPACE]?.find((tab) => tab.entityId === preview.id)
  ).toMatchObject({ groupId: 'a' })
  expect(state.groupsByWorktree[WORKSPACE]?.map((group) => group.id)).toEqual(['a', 'c'])
  expect(state.activeGroupIdByWorktree[WORKSPACE]).toBe('a')
  expect(state.activeBrowserTabId).toBe(preview.id)
  expect(layoutApplyTestTransport.mainModel?.workspaces[WORKSPACE]?.groupLayout).toEqual({
    type: 'split',
    direction: 'horizontal',
    ratio: 0.3,
    first: { type: 'leaf', groupId: 'a' },
    second: { type: 'leaf', groupId: 'c' }
  })
})

it('reveals an inactive document without relocating the other pages in its workspace', async () => {
  const preview = await createRemoteDocPreview()
  layoutApplyTestTransport.answerWith('apply')
  const webPage = store.getState().createBrowserPage(preview.id, 'https://example.com/unrelated')!
  await main.settle()
  expect(store.getState().browserTabsByWorktree[WORKSPACE]?.[0]?.activePageId).toBe(webPage.id)

  openFileInBrowserTab({ worktreeId: WORKSPACE, filePath: '/repo/index.html', targetGroupId: 'a' })
  await main.settle()

  const state = store.getState()
  expect(
    state.unifiedTabsByWorktree[WORKSPACE]?.find((tab) => tab.entityId === preview.id)
  ).toMatchObject({ groupId: 'b' })
  expect(state.groupsByWorktree[WORKSPACE]?.map((group) => group.id)).toEqual(['a', 'b', 'c'])
  expect(state.browserTabsByWorktree[WORKSPACE]).toHaveLength(1)
  expect(state.browserTabsByWorktree[WORKSPACE]?.[0]?.activePageId).toBe(preview.activePageId)
  expect(
    state.browserPagesByWorkspace[preview.id]?.find((page) => page.id === webPage.id)
  ).toMatchObject({ url: 'https://example.com/unrelated', workspaceId: preview.id })
  expect(state.activeGroupIdByWorktree[WORKSPACE]).toBe('b')
})

it('keeps a selected preview active when relocating it collapses its old pane', async () => {
  const preview = await createRemoteDocPreview()
  const tab = store
    .getState()
    .unifiedTabsByWorktree[WORKSPACE]!.find((candidate) => candidate.entityId === preview.id)!
  store.getState().activateTab(tab.id, { worktreeId: WORKSPACE })
  store.getState().focusGroup(WORKSPACE, 'b')

  openFileInBrowserTab({ worktreeId: WORKSPACE, filePath: '/repo/index.html', targetGroupId: 'a' })
  layoutApplyTestTransport.answerWith('apply')
  layoutApplyTestTransport.answerPending()
  await main.settle()

  const state = store.getState()
  expect(state.activeGroupIdByWorktree[WORKSPACE]).toBe('a')
  expect(state.groupsByWorktree[WORKSPACE]?.find((group) => group.id === 'a')?.activeTabId).toBe(
    tab.id
  )
  expect(state.activeBrowserTabId).toBe(preview.id)
})

it.each(['navigation', 'new-request'] as const)(
  'does not activate a reused preview after %s while its move is pending',
  async (change) => {
    const preview = await createRemoteDocPreview()
    openFileInBrowserTab({
      worktreeId: WORKSPACE,
      filePath: '/repo/index.html',
      targetGroupId: 'a'
    })
    if (change === 'navigation') {
      store.getState().activateTab('source', { worktreeId: WORKSPACE })
      store.getState().focusGroup(WORKSPACE, 'a')
      store.getState().activateTab('terminal-c', { worktreeId: WORKSPACE })
      store.getState().focusGroup(WORKSPACE, 'c')
    } else {
      beginLinkOpenRequest()
    }
    layoutApplyTestTransport.answerWith('apply')
    layoutApplyTestTransport.answerPending()
    await main.settle()

    const state = store.getState()
    expect(
      state.unifiedTabsByWorktree[WORKSPACE]?.find((tab) => tab.entityId === preview.id)
    ).toMatchObject({ groupId: 'a' })
    expect(state.activeGroupIdByWorktree[WORKSPACE]).toBe('c')
    expect(state.groupsByWorktree[WORKSPACE]?.find((group) => group.id === 'a')?.activeTabId).toBe(
      'source'
    )
  }
)

it.each(['navigation', 'new-request'] as const)(
  'does not activate a new HTML preview after %s while creation is pending',
  async (change) => {
    openFileInBrowserTab({
      worktreeId: WORKSPACE,
      filePath: '/repo/index.html',
      targetGroupId: 'a'
    })
    if (change === 'navigation') {
      store.getState().focusGroup(WORKSPACE, 'b')
      store.getState().activateTab('terminal-b', { worktreeId: WORKSPACE })
    } else {
      beginLinkOpenRequest()
    }
    layoutApplyTestTransport.answerWith('apply')
    layoutApplyTestTransport.answerPending()
    await main.settle()

    const state = store.getState()
    expect(state.browserTabsByWorktree[WORKSPACE]).toHaveLength(1)
    expect(state.activeGroupIdByWorktree[WORKSPACE]).toBe(change === 'navigation' ? 'b' : 'c')
    expect(state.groupsByWorktree[WORKSPACE]?.find((group) => group.id === 'a')?.activeTabId).toBe(
      'source'
    )
  }
)

it('activates a new HTML preview once main draws it while the selection stays current', async () => {
  openFileInBrowserTab({ worktreeId: WORKSPACE, filePath: '/repo/index.html', targetGroupId: 'a' })
  expect(store.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('c')

  layoutApplyTestTransport.answerWith('apply')
  layoutApplyTestTransport.answerPending()
  await main.settle()

  const state = store.getState()
  const preview = state.unifiedTabsByWorktree[WORKSPACE]?.find(
    (tab) => tab.contentType === 'browser'
  )
  expect(preview).toMatchObject({ groupId: 'a' })
  expect(state.activeBrowserTabId).toBe(preview!.entityId)
  expect(state.activeGroupIdByWorktree[WORKSPACE]).toBe('a')
  expect(state.groupsByWorktree[WORKSPACE]?.find((group) => group.id === 'a')?.activeTabId).toBe(
    preview!.id
  )
})

it('activates the first HTML preview before the workspace has a root group', async () => {
  main.close()
  store.setState({
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    layoutByWorktree: {},
    unifiedTabsByWorktree: {},
    tabsByWorktree: {}
  })
  main = await drawTabsFromMain(store)
  layoutApplyTestTransport.answerWith('pending')

  openFileInBrowserTab({ worktreeId: WORKSPACE, filePath: '/repo/index.html' })
  layoutApplyTestTransport.answerWith('apply')
  layoutApplyTestTransport.answerPending()
  await main.settle()

  const state = store.getState()
  expect(state.activeTabType).toBe('browser')
  expect(state.browserPagesByWorkspace[state.activeBrowserTabId!]?.[0]?.url).toBe(
    'file:///repo/index.html'
  )
})

it('activates an HTML preview created in the selected empty pane', async () => {
  const targetGroupId = store.getState().createEmptySplitGroup(WORKSPACE, 'a', 'right')!
  openFileInBrowserTab({ worktreeId: WORKSPACE, filePath: '/repo/index.html', targetGroupId })
  layoutApplyTestTransport.answerWith('apply')
  layoutApplyTestTransport.answerPending()
  await main.settle()

  const state = store.getState()
  const preview = state.unifiedTabsByWorktree[WORKSPACE]!.find(
    (tab) => tab.contentType === 'browser'
  )!
  expect(preview).toMatchObject({ groupId: targetGroupId })
  expect(state.activeBrowserTabId).toBe(preview.entityId)
  expect(state.activeTabType).toBe('browser')
})

it('reports a refused preview move and preserves the original pane', async () => {
  const preview = await createRemoteDocPreview()
  openFileInBrowserTab({ worktreeId: WORKSPACE, filePath: '/repo/index.html', targetGroupId: 'a' })
  layoutApplyTestTransport.answerWith({ refuse: 'group_not_found' })
  layoutApplyTestTransport.answerPending()
  await main.settle()

  const state = store.getState()
  expect(
    state.unifiedTabsByWorktree[WORKSPACE]?.find((tab) => tab.entityId === preview.id)
  ).toMatchObject({ groupId: 'b' })
  expect(state.activeGroupIdByWorktree[WORKSPACE]).toBe('c')
  expect(toast.error).toHaveBeenCalled()
})

it('reports a failed preview move call and preserves the original pane', async () => {
  const preview = await createRemoteDocPreview()
  const call = vi
    .spyOn(layoutApplyTestTransport, 'call')
    .mockRejectedValueOnce(new Error('disconnected'))
  try {
    openFileInBrowserTab({
      worktreeId: WORKSPACE,
      filePath: '/repo/index.html',
      targetGroupId: 'a'
    })
    await main.settle()

    const state = store.getState()
    expect(
      state.unifiedTabsByWorktree[WORKSPACE]?.find((tab) => tab.entityId === preview.id)
    ).toMatchObject({ groupId: 'b' })
    expect(state.activeGroupIdByWorktree[WORKSPACE]).toBe('c')
    expect(toast.error).toHaveBeenCalled()
  } finally {
    call.mockRestore()
  }
})
