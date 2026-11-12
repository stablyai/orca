import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { createStoreCascadesMockApi } from '@/store/testing/app-store-cascade-api.test-fixture'
import {
  EDITOR_OWNER,
  EDITOR_PLACEMENT,
  seedEditorPlacementConsumers
} from '@/store/slices/editor/tabs/editor-placement-consumers.test-fixture'
import {
  seedBrowserLinkTestStore,
  WORKSPACE
} from '@/lib/browser/navigation/browser-link-open.test-fixture'
import { beginLinkOpenRequest } from '@/lib/links/link-open-request'
import { registerEditorFrameFlush } from './save/flush/editor-pending-flush'
import { openEditorHtmlPreview } from './open-editor-html-preview'

vi.mock('@/components/browser-pane/host-guest/browser-focus', () => ({
  requestBrowserFocus: vi.fn()
}))

const initialState = useAppStore.getInitialState()

beforeEach(() => {
  createStoreCascadesMockApi()
  useAppStore.setState(initialState, true)
  seedBrowserLinkTestStore(useAppStore)
  useAppStore.setState((state) => ({
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
    activeFileId: 'report',
    unifiedTabsByWorktree: {
      [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) =>
        tab.id === 'source' ? { ...tab, contentType: 'editor', entityId: 'report' } : tab
      )
    }
  }))
})
afterEach(() => useAppStore.setState(initialState, true))

it('opens HTML in its editor group even when another pane is active, and reuses it on repeat', async () => {
  await openEditorHtmlPreview('report', 'source')
  const state = useAppStore.getState()
  const browser = state.unifiedTabsByWorktree[WORKSPACE]!.find(
    (tab) => tab.contentType === 'browser'
  )!
  expect(browser).toMatchObject({ groupId: 'a' })
  expect(state.browserPagesByWorkspace[browser.entityId]?.[0]?.url).toBe('file:///repo/report.html')
  expect(state.activeGroupIdByWorktree[WORKSPACE]).toBe('a')

  state.activateTab('source', { worktreeId: WORKSPACE })
  await openEditorHtmlPreview('report', 'source')
  expect(useAppStore.getState().browserTabsByWorktree[WORKSPACE]).toHaveLength(1)
  expect(useAppStore.getState().activeBrowserTabId).toBe(browser.entityId)
})

it('waits for the guest flush and follows its editor when the view moves', async () => {
  const flush = Promise.withResolvers<boolean>()
  const unregister = registerEditorFrameFlush('report', () => flush.promise)
  try {
    const opening = openEditorHtmlPreview('report', 'source')
    expect(useAppStore.getState().browserTabsByWorktree[WORKSPACE] ?? []).toEqual([])
    useAppStore.getState().moveUnifiedTabToGroup('source', 'b', { activate: true })
    flush.resolve(true)
    await opening
    expect(
      useAppStore
        .getState()
        .unifiedTabsByWorktree[WORKSPACE]?.find((tab) => tab.contentType === 'browser')
    ).toMatchObject({ groupId: 'b' })
    expect(useAppStore.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('b')
  } finally {
    unregister()
  }
})

function seedRemoteFileInFolder() {
  const file = seedEditorPlacementConsumers({
    mode: 'edit',
    filePath: '/repo/report.html',
    relativePath: 'report.html',
    language: 'html',
    externalSshTargetId: 'file-owner'
  })
  useAppStore.setState((state) => ({
    repos: state.repos.map((repo) => ({
      ...repo,
      connectionId: 'file-owner',
      executionHostId: 'ssh:file-owner'
    })),
    worktreesByRepo: {
      repo1: state.worktreesByRepo.repo1!.map((worktree) => ({
        ...worktree,
        hostId: 'ssh:file-owner'
      }))
    }
  }))
  return file
}

it('opens a remote child file in the folder group containing its editor view', async () => {
  const file = seedRemoteFileInFolder()
  await openEditorHtmlPreview(file.id, 'x-source-tab')
  const state = useAppStore.getState()
  const browser = state.unifiedTabsByWorktree[EDITOR_PLACEMENT]!.find(
    (tab) => tab.contentType === 'browser'
  )!
  expect(browser).toMatchObject({
    groupId: 'x-source',
    worktreeId: EDITOR_PLACEMENT,
    executionHostId: 'local'
  })
  expect(state.browserPagesByWorkspace[browser.entityId]?.[0]).toMatchObject({
    worktreeId: EDITOR_PLACEMENT,
    browserRuntimeEnvironmentId: null,
    docLocation: { kind: 'workspace-doc', worktreeId: EDITOR_OWNER, filePath: '/repo/report.html' }
  })
  expect(state.activeWorktreeId).toBe(EDITOR_PLACEMENT)
  expect(state.activeBrowserTabId).toBe(browser.entityId)
  expect(state.browserTabsByWorktree[EDITOR_OWNER] ?? []).toEqual([])
})

it('refuses a remote file whose owner changes while its editor flushes', async () => {
  const file = seedRemoteFileInFolder()
  const flush = Promise.withResolvers<boolean>()
  const unregister = registerEditorFrameFlush(file.id, () => flush.promise)
  try {
    const opening = openEditorHtmlPreview(file.id, 'x-source-tab')
    useAppStore.setState((state) => ({
      repos: state.repos.map((repo) => ({
        ...repo,
        connectionId: 'changed-owner',
        executionHostId: 'ssh:changed-owner'
      })),
      worktreesByRepo: {
        repo1: state.worktreesByRepo.repo1!.map((worktree) => ({
          ...worktree,
          hostId: 'ssh:changed-owner'
        }))
      },
      openFiles: state.openFiles.map((entry) => ({
        ...entry,
        externalSshTargetId: 'changed-owner'
      }))
    }))
    flush.resolve(true)
    await opening
    expect(useAppStore.getState().browserTabsByWorktree[EDITOR_PLACEMENT] ?? []).toEqual([])
  } finally {
    unregister()
  }
})

it('refuses an unstamped child file whose workspace owner changes during flush', async () => {
  const file = seedEditorPlacementConsumers({
    mode: 'edit',
    filePath: '/repo/report.html',
    relativePath: 'report.html',
    language: 'html',
    runtimeEnvironmentId: undefined
  })
  const flush = Promise.withResolvers<boolean>()
  const unregister = registerEditorFrameFlush(file.id, () => flush.promise)
  try {
    const opening = openEditorHtmlPreview(file.id, 'x-source-tab')
    useAppStore.setState((state) => ({
      repos: state.repos.map((repo) => ({
        ...repo,
        connectionId: 'replacement-owner',
        executionHostId: 'ssh:replacement-owner'
      })),
      worktreesByRepo: {
        repo1: state.worktreesByRepo.repo1!.map((worktree) => ({
          ...worktree,
          hostId: 'ssh:replacement-owner'
        }))
      }
    }))
    flush.resolve(true)
    await opening
    expect(useAppStore.getState().browserTabsByWorktree[EDITOR_PLACEMENT] ?? []).toEqual([])
  } finally {
    unregister()
  }
})

async function previewWhileFlushing(changeIntent: () => void): Promise<void> {
  const flush = Promise.withResolvers<boolean>()
  const unregister = registerEditorFrameFlush('report', () => flush.promise)
  try {
    const opening = openEditorHtmlPreview('report', 'source')
    changeIntent()
    flush.resolve(true)
    await opening
  } finally {
    unregister()
  }
}

it('refuses a local preview when the file gains remote host evidence during its flush', async () => {
  await previewWhileFlushing(() => {
    useAppStore.setState((state) => ({
      openFiles: state.openFiles.map((file) => ({ ...file, externalSshTargetId: 'file-owner' }))
    }))
  })
  expect(useAppStore.getState().browserTabsByWorktree[WORKSPACE] ?? []).toEqual([])
})

it('cancels preview when its editor tab closes but the file stays open in another tab', async () => {
  useAppStore.setState((state) => ({
    unifiedTabsByWorktree: {
      [WORKSPACE]: [
        ...state.unifiedTabsByWorktree[WORKSPACE]!,
        { ...state.unifiedTabsByWorktree[WORKSPACE]![0]!, id: 'other-view', groupId: 'b' }
      ]
    },
    groupsByWorktree: {
      [WORKSPACE]: state.groupsByWorktree[WORKSPACE]!.map((group) =>
        group.id === 'b' ? { ...group, tabOrder: [...group.tabOrder, 'other-view'] } : group
      )
    }
  }))
  await previewWhileFlushing(() => useAppStore.getState().closeUnifiedTab('source'))
  expect(useAppStore.getState().openFiles.map((file) => file.id)).toEqual(['report'])
  expect(useAppStore.getState().browserTabsByWorktree[WORKSPACE] ?? []).toEqual([])
})

it('cancels preview after leaving the workspace even if the user returns before flush', async () => {
  await previewWhileFlushing(() => {
    useAppStore.getState().setActiveWorktree(null)
    useAppStore.setState({ activeWorktreeId: WORKSPACE })
  })
  expect(useAppStore.getState().browserTabsByWorktree[WORKSPACE] ?? []).toEqual([])
})

it('cancels preview after switching tabs even if the editor is selected again before flush', async () => {
  await previewWhileFlushing(() => {
    useAppStore.getState().moveUnifiedTabToGroup('terminal-b', 'a')
    useAppStore.getState().activateTab('terminal-b', { worktreeId: WORKSPACE })
    useAppStore.getState().activateTab('source', { worktreeId: WORKSPACE })
  })
  expect(useAppStore.getState().browserTabsByWorktree[WORKSPACE] ?? []).toEqual([])
})

it('cancels preview after navigating away from a moved editor even if the user returns', async () => {
  await previewWhileFlushing(() => {
    useAppStore.getState().moveUnifiedTabToGroup('source', 'b', { activate: true })
    useAppStore.getState().focusGroup(WORKSPACE, 'c')
    useAppStore.getState().focusGroup(WORKSPACE, 'b')
  })
  expect(useAppStore.getState().browserTabsByWorktree[WORKSPACE] ?? []).toEqual([])
})

it('cancels preview when a newer open request supersedes it', async () => {
  await previewWhileFlushing(() => {
    beginLinkOpenRequest()
  })
  expect(useAppStore.getState().browserTabsByWorktree[WORKSPACE] ?? []).toEqual([])
})
