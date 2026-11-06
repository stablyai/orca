// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { TabsDrawnFromMain } from '@/store/slices/tabs-drawn-from-main.test-fixture'
import {
  EDITOR_OWNER,
  EDITOR_PLACEMENT,
  seedEditorPlacementConsumers,
  drawEditorPlacementConsumers
} from '@/store/slices/editor-placement-consumers.test-fixture'
import { useTerminalBulkCloseActions } from './use-terminal-bulk-close-actions'
import { useTerminalEditorCloseFoundation } from './use-terminal-editor-close-foundation'
import { useTerminalEditorCloseQueue } from './use-terminal-editor-close-queue'
import { useTerminalEditorCloseDialogActions } from './use-terminal-editor-close-dialog-actions'
import {
  ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
  type EditorSaveAndCloseDetail
} from './editor/autosave/editor-autosave'
import { openNewTerminalTabInWorkspace } from '@/store/terminals/terminal-active-workspace-creation'
import { persistAgentLaunchTabOrder } from '@/lib/launch-agent-tab-order'

vi.mock('@/runtime/runtime-rpc-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)
vi.mock('./use-bulk-tab-close-confirmation', () => ({
  useBulkTabCloseConfirmation:
    () => (_scope: string, select: () => string[], close: (ids: string[]) => void) =>
      close(select())
}))

let main: TabsDrawnFromMain | undefined
afterEach(() => {
  cleanup()
  main?.close()
  main = undefined
})
function mountCloseActions() {
  return renderHook(() => {
    const openFiles = useAppStore((state) => state.openFiles)
    const state = useAppStore.getState()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the projection fields read by close hooks are needed.
    const projection = {
      ...state,
      openFiles,
      activeWorktreeId: EDITOR_PLACEMENT
    } as unknown as Parameters<typeof useTerminalEditorCloseFoundation>[0]
    const foundation = useTerminalEditorCloseFoundation(projection)
    const queue = useTerminalEditorCloseQueue({ ...projection, ...foundation })
    const dialog = useTerminalEditorCloseDialogActions({ ...projection, ...foundation, ...queue })
    const bulk = useTerminalBulkCloseActions({ ...projection, ...queue })
    return { ...foundation, ...queue, ...dialog, ...bulk }
  })
}

it('close-all removes folder placements while retaining child content, drafts and its own tab', async () => {
  const file = seedEditorPlacementConsumers({ mode: 'edit' })
  main = await drawEditorPlacementConsumers()
  useAppStore.getState().setEditorDraft(file.id, 'unsaved text')
  useAppStore.getState().markFileDirty(file.id, true)
  const hook = mountCloseActions()
  act(() => hook.result.current.handleCloseAllFiles())
  await main.settle()
  expect(useAppStore.getState().unifiedTabsByWorktree[EDITOR_PLACEMENT] ?? []).toEqual([])
  expect(useAppStore.getState().unifiedTabsByWorktree[EDITOR_OWNER]?.map((tab) => tab.id)).toEqual([
    'y-tab'
  ])
  expect(useAppStore.getState().editorDrafts[file.id]).toBe('unsaved text')
  expect(hook.result.current.saveDialogFileId).toBeNull()
  expect(useAppStore.getState().recentlyClosedEditorTabsByWorktree[EDITOR_PLACEMENT]).toHaveLength(
    2
  )
})

it('confirms only the final dirty placement, keeps its tab through Save, and spares a later sibling', async () => {
  const file = seedEditorPlacementConsumers({ mode: 'edit' }, false)
  main = await drawEditorPlacementConsumers()
  useAppStore.getState().setEditorDraft(file.id, 'unsaved text')
  useAppStore.getState().markFileDirty(file.id, true)
  const hook = mountCloseActions()
  act(() => hook.result.current.handleCloseAllFiles())
  await act(async () => main!.settle())
  expect(hook.result.current.saveDialogFileId).toBe(file.id)
  expect(hook.result.current.queuedEditorCloseTabId(file.id)).toBe('x-other-tab')
  expect(
    useAppStore.getState().unifiedTabsByWorktree[EDITOR_PLACEMENT]?.map((tab) => tab.id)
  ).toEqual(['x-other-tab'])
  useAppStore.getState().openFile(file, { placementWorkspaceId: EDITOR_OWNER, preview: false })
  await act(async () => main!.settle())
  const onSave = (event: Event) => {
    if (!(event instanceof CustomEvent)) {
      throw new Error('Expected save-and-close details')
    }
    const detail: EditorSaveAndCloseDetail = event.detail
    expect(detail).toMatchObject({ fileId: file.id, tabId: 'x-other-tab' })
    useAppStore.getState().markFileDirty(file.id, false)
    useAppStore.getState().closeUnifiedTab(detail.tabId!)
  }
  window.addEventListener(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, onSave)
  try {
    await act(async () => {
      await hook.result.current.handleSaveDialogSave()
      await main!.settle()
    })
  } finally {
    window.removeEventListener(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, onSave)
  }
  expect(useAppStore.getState().unifiedTabsByWorktree[EDITOR_PLACEMENT] ?? []).toEqual([])
  expect(useAppStore.getState().unifiedTabsByWorktree[EDITOR_OWNER]).toHaveLength(1)
  expect(useAppStore.getState().openFiles).toHaveLength(1)
})

it('does not discard a shared dirty record when another view opens during confirmation', async () => {
  const file = seedEditorPlacementConsumers({ mode: 'edit' }, false)
  main = await drawEditorPlacementConsumers()
  useAppStore.getState().setEditorDraft(file.id, 'keep these edits')
  useAppStore.getState().markFileDirty(file.id, true)
  const hook = mountCloseActions()
  act(() => hook.result.current.handleCloseAllFiles())
  await act(async () => main!.settle())
  useAppStore.getState().openFile(file, { placementWorkspaceId: EDITOR_OWNER, preview: false })
  await act(async () => main!.settle())
  await act(async () => {
    await hook.result.current.handleSaveDialogDiscard()
    await main!.settle()
  })
  expect(useAppStore.getState().editorDrafts[file.id]).toBe('keep these edits')
  expect(useAppStore.getState().unifiedTabsByWorktree[EDITOR_OWNER]).toHaveLength(1)
  expect(useAppStore.getState().unifiedTabsByWorktree[EDITOR_PLACEMENT] ?? []).toEqual([])
})

it('keeps both placement ids when agent launch persists mixed tab order', () => {
  seedEditorPlacementConsumers()
  persistAgentLaunchTabOrder(EDITOR_PLACEMENT, 'new-agent')
  expect(useAppStore.getState().tabBarOrderByWorktree[EDITOR_PLACEMENT]).toEqual([
    'x-source-tab',
    'x-other-tab',
    'new-agent'
  ])
})

it.each([3, 30])(
  'publishes one recent-close history update for %i folder placements',
  async (count) => {
    seedEditorPlacementConsumers()
    const source = useAppStore.getState().unifiedTabsByWorktree[EDITOR_PLACEMENT]![0]!
    const views = Array.from({ length: count }, (_, index) => ({
      ...source,
      id: `folder-view-${index}`,
      entityId: `folder-content-${index}`
    }))
    const file = useAppStore.getState().openFiles[0]!
    useAppStore.setState({
      openFiles: [
        file,
        ...views.map((view, index) => ({
          ...file,
          id: view.entityId,
          filePath: `/repo/file-${index}.md`,
          relativePath: `file-${index}.md`
        }))
      ],
      unifiedTabsByWorktree: {
        ...useAppStore.getState().unifiedTabsByWorktree,
        [EDITOR_PLACEMENT]: views
      },
      groupsByWorktree: {
        ...useAppStore.getState().groupsByWorktree,
        [EDITOR_PLACEMENT]: [
          {
            id: 'x-source',
            worktreeId: EDITOR_PLACEMENT,
            activeTabId: views[0]!.id,
            tabOrder: views.map((tab) => tab.id)
          }
        ]
      },
      layoutByWorktree: {
        ...useAppStore.getState().layoutByWorktree,
        [EDITOR_PLACEMENT]: { type: 'leaf', groupId: 'x-source' }
      },
      activeGroupIdByWorktree: {
        ...useAppStore.getState().activeGroupIdByWorktree,
        [EDITOR_PLACEMENT]: 'x-source'
      }
    })
    main = await drawEditorPlacementConsumers()
    let historyUpdates = 0
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        state.recentlyClosedEditorTabsByWorktree !== previous.recentlyClosedEditorTabsByWorktree
      ) {
        historyUpdates += 1
      }
    })
    try {
      useAppStore.getState().closeUnifiedTabs(views.map((tab) => tab.id))
      await main.settle()
    } finally {
      unsubscribe()
    }
    expect(historyUpdates).toBe(1)
    expect(useAppStore.getState().unifiedTabsByWorktree[EDITOR_PLACEMENT] ?? []).toEqual([])
    expect(
      useAppStore.getState().unifiedTabsByWorktree[EDITOR_OWNER]?.map((tab) => tab.id)
    ).toEqual(['y-tab'])
  }
)

it('retains placement order across browser, terminal and agent openings', async () => {
  seedEditorPlacementConsumers()
  main = await drawEditorPlacementConsumers()
  useAppStore.getState().createBrowserTab(EDITOR_PLACEMENT, 'https://example.com')
  await main.settle()
  const browserId = useAppStore.getState().browserTabsByWorktree[EDITOR_PLACEMENT]![0]!.id
  expect(useAppStore.getState().tabBarOrderByWorktree[EDITOR_PLACEMENT]).toEqual([
    'x-source-tab',
    'x-other-tab',
    browserId
  ])
  await openNewTerminalTabInWorkspace(useAppStore.getState, EDITOR_PLACEMENT)
  await main.settle()
  const terminalId = useAppStore.getState().tabsByWorktree[EDITOR_PLACEMENT]![0]!.id
  expect(useAppStore.getState().tabBarOrderByWorktree[EDITOR_PLACEMENT]).toEqual([
    'x-source-tab',
    'x-other-tab',
    browserId,
    terminalId
  ])
  persistAgentLaunchTabOrder(EDITOR_PLACEMENT, terminalId)
  expect(useAppStore.getState().tabBarOrderByWorktree[EDITOR_PLACEMENT]).toEqual([
    'x-source-tab',
    'x-other-tab',
    browserId,
    terminalId
  ])
  const secondBrowser = useAppStore
    .getState()
    .createBrowserTab(EDITOR_PLACEMENT, 'https://example.org')
  await main.settle()
  expect(useAppStore.getState().tabBarOrderByWorktree[EDITOR_PLACEMENT]).toEqual([
    'x-source-tab',
    'x-other-tab',
    browserId,
    terminalId,
    secondBrowser.id
  ])
})
