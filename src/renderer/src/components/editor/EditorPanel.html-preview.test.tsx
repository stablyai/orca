// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  seedBrowserLinkTestStore,
  WORKSPACE
} from '@/lib/browser/navigation/browser-link-open.test-fixture'
import { beginLinkOpenRequest } from '@/lib/link-open-request'
import { registerEditorFrameFlush } from './save/flush/editor-pending-flush'

vi.mock('./useEditorPanelContentState', () => ({
  useEditorPanelContentState: () => ({
    fileContents: {},
    diffContents: {},
    reloadContent: () => {}
  })
}))
vi.mock('./EditorPanelShell', () => ({
  EditorPanelShell: ({ onOpenPreview }: { onOpenPreview: () => void }) => (
    <button onClick={onOpenPreview}>Preview</button>
  )
}))

import EditorPanel from './EditorPanel'

const initialState = useAppStore.getInitialState()
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useAppStore.setState(initialState, true)
})

it('opens HTML in its editor group even when another pane is active', async () => {
  await act(async () => root.render(<EditorPanel activeViewStateId="source" />))
  await act(async () => container.querySelector('button')!.click())

  const state = useAppStore.getState()
  const browser = state.unifiedTabsByWorktree[WORKSPACE]?.find(
    (tab) => tab.contentType === 'browser'
  )
  expect(browser).toMatchObject({ groupId: 'a' })
  expect(state.browserPagesByWorkspace[browser!.entityId]?.[0]?.url).toBe(
    'file:///repo/report.html'
  )
  expect(state.activeGroupIdByWorktree[WORKSPACE]).toBe('a')
})

it('waits for the guest flush before preview and uses the editor’s current group', async () => {
  let finishFlush: (flushed: boolean) => void = () => {}
  const unregister = registerEditorFrameFlush(
    'report',
    () => new Promise((resolve) => (finishFlush = resolve))
  )
  try {
    await act(async () => root.render(<EditorPanel activeViewStateId="source" />))
    await act(async () => container.querySelector('button')!.click())
    expect(useAppStore.getState().browserTabsByWorktree[WORKSPACE] ?? []).toEqual([])

    await act(async () => {
      useAppStore.getState().moveUnifiedTabToGroup('source', 'b', { activate: true })
      finishFlush(true)
    })

    const state = useAppStore.getState()
    expect(
      state.unifiedTabsByWorktree[WORKSPACE]?.find((tab) => tab.contentType === 'browser')
    ).toMatchObject({ groupId: 'b' })
    expect(state.activeGroupIdByWorktree[WORKSPACE]).toBe('b')
  } finally {
    unregister()
  }
})

it('brings an existing remote HTML preview into its editor group', async () => {
  const host = 'ssh:preview-owner'
  useAppStore.setState((state) => ({
    repos: state.repos.map((repo) => ({
      ...repo,
      connectionId: 'preview-owner',
      executionHostId: host
    })),
    worktreesByRepo: {
      repo1: state.worktreesByRepo.repo1!.map((worktree) => ({ ...worktree, hostId: host }))
    },
    activeWorkspaceExecutionHostId: host,
    unifiedTabsByWorktree: {
      [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
        ...tab,
        executionHostId: host
      }))
    }
  }))
  const preview = useAppStore.getState().createBrowserTab(WORKSPACE, '', {
    targetGroupId: 'b',
    browserRuntimeEnvironmentId: null,
    docLocation: { kind: 'workspace-doc', worktreeId: WORKSPACE, filePath: '/repo/report.html' },
    activate: false
  })

  await act(async () => root.render(<EditorPanel activeViewStateId="source" />))
  await act(async () => container.querySelector('button')!.click())

  const state = useAppStore.getState()
  expect(
    state.unifiedTabsByWorktree[WORKSPACE]?.find((tab) => tab.entityId === preview.id)
  ).toMatchObject({
    groupId: 'a'
  })
  expect(state.activeGroupIdByWorktree[WORKSPACE]).toBe('a')
  expect(state.activeBrowserTabId).toBe(preview.id)
})

async function previewWhileFlushing(changeIntent: () => void): Promise<void> {
  const flush = Promise.withResolvers<boolean>()
  const unregister = registerEditorFrameFlush('report', () => flush.promise)
  try {
    await act(async () => root.render(<EditorPanel activeViewStateId="source" />))
    await act(async () => container.querySelector('button')!.click())
    await act(async () => {
      changeIntent()
      flush.resolve(true)
    })
  } finally {
    unregister()
  }
}

it.each(['refused', 'rejected'] as const)(
  'keeps the editor selected when its guest flush is %s',
  async (failure) => {
    const unregister = registerEditorFrameFlush('report', () =>
      failure === 'refused' ? Promise.resolve(false) : Promise.reject(new Error('flush failed'))
    )
    try {
      await act(async () => root.render(<EditorPanel activeViewStateId="source" />))
      await act(async () => container.querySelector('button')!.click())

      const state = useAppStore.getState()
      expect(state.browserTabsByWorktree[WORKSPACE] ?? []).toEqual([])
      expect(
        state.groupsByWorktree[WORKSPACE]?.find((group) => group.id === 'a')?.activeTabId
      ).toBe('source')
    } finally {
      unregister()
    }
  }
)

it('cancels preview when its editor tab closes but the file stays open in another tab', async () => {
  useAppStore.setState((state) => ({
    unifiedTabsByWorktree: {
      [WORKSPACE]: [
        ...state.unifiedTabsByWorktree[WORKSPACE]!,
        {
          ...state.unifiedTabsByWorktree[WORKSPACE]![0]!,
          id: 'other-view',
          groupId: 'b'
        }
      ]
    },
    groupsByWorktree: {
      [WORKSPACE]: state.groupsByWorktree[WORKSPACE]!.map((group) =>
        group.id === 'b'
          ? {
              ...group,
              tabOrder: [...group.tabOrder, 'other-view']
            }
          : group
      )
    }
  }))
  await previewWhileFlushing(() => {
    useAppStore.getState().closeUnifiedTab('source')
  })

  const state = useAppStore.getState()
  expect(state.openFiles.map((file) => file.id)).toEqual(['report'])
  expect(state.browserTabsByWorktree[WORKSPACE] ?? []).toEqual([])
  expect(state.unifiedTabsByWorktree[WORKSPACE]?.some((tab) => tab.id === 'source')).toBe(false)
})

it('cancels preview after leaving the workspace even if the user returns before flush', async () => {
  await previewWhileFlushing(() => {
    useAppStore.getState().setActiveWorktree(null)
    useAppStore.setState({ activeWorktreeId: WORKSPACE })
  })

  expect(useAppStore.getState().browserTabsByWorktree[WORKSPACE] ?? []).toEqual([])
  expect(useAppStore.getState().activeWorktreeId).toBe(WORKSPACE)
})

it('cancels preview when another tab replaces the source in its group', async () => {
  await previewWhileFlushing(() => {
    useAppStore.getState().moveUnifiedTabToGroup('terminal-b', 'a')
    useAppStore.getState().activateTab('terminal-b', { worktreeId: WORKSPACE })
  })

  const state = useAppStore.getState()
  expect(state.browserTabsByWorktree[WORKSPACE] ?? []).toEqual([])
  expect(state.groupsByWorktree[WORKSPACE]?.find((group) => group.id === 'a')?.activeTabId).toBe(
    'terminal-b'
  )
})

it('keeps another pane selected when the user switches during the editor flush', async () => {
  useAppStore.getState().focusGroup(WORKSPACE, 'a')
  await previewWhileFlushing(() => {
    useAppStore.getState().focusGroup(WORKSPACE, 'b')
  })

  const state = useAppStore.getState()
  expect(state.activeGroupIdByWorktree[WORKSPACE]).toBe('b')
  expect(state.browserTabsByWorktree[WORKSPACE] ?? []).toEqual([])
})

it('cancels preview when a newer open request supersedes it', async () => {
  await previewWhileFlushing(() => {
    beginLinkOpenRequest()
  })

  const state = useAppStore.getState()
  expect(state.browserTabsByWorktree[WORKSPACE] ?? []).toEqual([])
  expect(state.groupsByWorktree[WORKSPACE]?.find((group) => group.id === 'a')?.activeTabId).toBe(
    'source'
  )
})
