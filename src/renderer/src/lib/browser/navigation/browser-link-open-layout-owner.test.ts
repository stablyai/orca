import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/browser-focus'
import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'
import { isBrowserPageMountAdmitted } from '@/components/browser-pane/host-guest/browser-page-mount-admission'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStoreCascadesMockApi } from '@/store/testing/app-store-cascade-api.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs/tabs-drawn-from-main.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'
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
import { openEditorHtmlPreview } from '@/components/editor/open-editor-html-preview'
import type { BrowserOpenOutcome } from './browser-link-destination'

vi.mock('../../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
const mocks = vi.hoisted(() => ({ getState: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => mocks.getState(), subscribe: mocks.subscribe }
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
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

it('opens a remote document in the requested group without moving an existing mixed browser workspace', async () => {
  const owner = 'repo2::/remote'
  store.setState((state) => ({
    repos: [
      ...state.repos,
      {
        ...state.repos[0]!,
        id: 'repo2',
        connectionId: 'preview-owner',
        executionHostId: 'ssh:preview-owner'
      }
    ],
    worktreesByRepo: {
      ...state.worktreesByRepo,
      repo2: [
        makeWorktree({ id: owner, repoId: 'repo2', path: '/remote', hostId: 'ssh:preview-owner' })
      ]
    }
  }))
  const openPreview = () =>
    new Promise<BrowserOpenOutcome>((resolve) =>
      openFileInBrowserTab({
        filePath: '/remote/index.html',
        worktreeId: owner,
        placementWorkspaceId: WORKSPACE,
        linkContext: {
          linkIntent: captureLinkOpenIntent(store.getState(), WORKSPACE, 'source', {
            explicitSourceGroup: true
          }),
          isCurrentRequest: beginLinkOpenRequest()
        },
        onLinkOutcome: resolve
      })
    )
  layoutApplyTestTransport.answerWith('apply')
  const existing = store.getState().createBrowserTab(WORKSPACE, '', {
    targetGroupId: 'b',
    browserRuntimeEnvironmentId: null,
    docLocation: { kind: 'workspace-doc', worktreeId: owner, filePath: '/remote/index.html' },
    activate: false
  })
  await main.settle()
  const unrelated = store
    .getState()
    .createBrowserPage(existing.id, 'https://example.com/unrelated')!
  await main.settle()
  layoutApplyTestTransport.answerWith('pending')

  const opening = openPreview()
  layoutApplyTestTransport.answerWith('apply')
  layoutApplyTestTransport.answerPending()
  await main.settle()
  expect(await opening).toMatchObject({ status: 'opened', result: { groupId: 'a' } })
  const state = store.getState()
  expect(
    state.unifiedTabsByWorktree[WORKSPACE]?.find((tab) => tab.entityId === existing.id)
  ).toMatchObject({ groupId: 'b' })
  expect(
    state.browserTabsByWorktree[WORKSPACE]?.find((tab) => tab.id === existing.id)?.activePageId
  ).toBe(unrelated.id)
  expect(state.browserPagesByWorkspace[existing.id]).toHaveLength(2)
  expect(state.groupsByWorktree[WORKSPACE]?.map((group) => group.id)).toEqual(['a', 'b', 'c'])
  const preview = state.activeBrowserTabId
  expect(preview).not.toBe(existing.id)
  expect(state.browserPagesByWorkspace[preview!]?.[0]?.docLocation).toEqual({
    kind: 'workspace-doc',
    worktreeId: owner,
    filePath: '/remote/index.html'
  })
  expect(await openPreview()).toMatchObject({
    status: 'opened',
    result: { browserWorkspaceId: preview, groupId: 'a' }
  })
  expect(store.getState().browserTabsByWorktree[WORKSPACE]).toHaveLength(2)
})

it('keeps the editor selected after navigating away and back while main creates its preview', async () => {
  store.setState((state) => ({
    openFiles: [
      {
        id: 'report',
        filePath: '/repo/report.html',
        relativePath: 'report.html',
        worktreeId: WORKSPACE,
        language: 'html',
        mode: 'edit',
        isDirty: false
      }
    ],
    unifiedTabsByWorktree: {
      [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) =>
        tab.id === 'source' ? { ...tab, contentType: 'editor', entityId: 'report' } : tab
      )
    }
  }))
  store.getState().focusGroup(WORKSPACE, 'a')
  const opening = openEditorHtmlPreview('report', 'source')
  await Promise.resolve()
  store.getState().focusGroup(WORKSPACE, 'b')
  store.getState().focusGroup(WORKSPACE, 'a')
  layoutApplyTestTransport.answerWith('apply')
  layoutApplyTestTransport.answerPending()
  await main.settle()
  await opening
  const state = store.getState()
  expect(state.groupsByWorktree[WORKSPACE]?.find((group) => group.id === 'a')?.activeTabId).toBe(
    'source'
  )
  expect(state.activeGroupIdByWorktree[WORKSPACE]).toBe('a')
  expect(
    state.unifiedTabsByWorktree[WORKSPACE]?.find((tab) => tab.contentType === 'browser')
  ).toMatchObject({ groupId: 'a' })
  expect(requestBrowserFocus).not.toHaveBeenCalled()
})
