// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { TabsDrawnFromMain } from '@/store/slices/tabs-drawn-from-main.test-fixture'
import {
  EDITOR_OWNER,
  EDITOR_PLACEMENT,
  seedEditorPlacementConsumers,
  drawEditorPlacementConsumers
} from '@/store/slices/editor/tabs/editor-placement-consumers.test-fixture'
import type { EditorToggleValue } from './view-mode/EditorViewToggle'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)
vi.mock('./useEditorPanelContentState', () => ({
  useEditorPanelContentState: () => ({
    fileContents: {},
    diffContents: {},
    reloadContent: () => {}
  })
}))
vi.mock('./EditorPanelShell', () => ({
  EditorPanelShell: ({
    onOpenDiffTargetFile,
    onEditorToggleChange,
    onOpenMarkdownPreview,
    onOpenPreviewToSide
  }: {
    onOpenDiffTargetFile: () => void
    onEditorToggleChange: (mode: EditorToggleValue) => void
    onOpenMarkdownPreview: () => void
    onOpenPreviewToSide: () => void
  }) => (
    <>
      <button onClick={onOpenDiffTargetFile}>Open</button>
      <button onClick={() => onEditorToggleChange('rich')}>Rich</button>
      <button onClick={onOpenMarkdownPreview}>Markdown preview</button>
      <button onClick={onOpenPreviewToSide}>Side preview</button>
    </>
  )
}))
import EditorPanel from './EditorPanel'

let main: TabsDrawnFromMain | undefined
afterEach(() => {
  cleanup()
  main?.close()
  main = undefined
})

it.each(['Open', 'Rich', 'Markdown preview'])(
  '%s from a child diff opens the result in the invoking folder group',
  async (action) => {
    const file = seedEditorPlacementConsumers()
    main = await drawEditorPlacementConsumers()
    const screen = render(<EditorPanel activeFileId={file.id} activeViewStateId="x-source-tab" />)
    fireEvent.click(screen.getByText(action))
    await main.settle()
    const state = useAppStore.getState()
    const result = state.openFiles.find(
      (entry) => entry.mode === (action === 'Markdown preview' ? 'markdown-preview' : 'edit')
    )
    expect(result).toMatchObject({
      worktreeId: EDITOR_OWNER,
      filePath: '/repo/notes.md',
      runtimeEnvironmentId: null
    })
    expect(
      state.unifiedTabsByWorktree[EDITOR_PLACEMENT]?.find((tab) => tab.entityId === result?.id)
    ).toMatchObject({ groupId: 'x-source' })
    expect(state.unifiedTabsByWorktree[EDITOR_OWNER]?.map((tab) => tab.id)).toEqual(['y-tab'])
    if (action === 'Rich') {
      expect(state.markdownViewMode[result!.id]).toBe('rich')
    }
  }
)

it('opens an HTML side preview beside its invoking folder group', async () => {
  const file = seedEditorPlacementConsumers({
    filePath: '/repo/index.html',
    relativePath: 'index.html',
    language: 'html'
  })
  main = await drawEditorPlacementConsumers()
  const screen = render(<EditorPanel activeFileId={file.id} activeViewStateId="x-source-tab" />)
  fireEvent.click(screen.getByText('Side preview'))
  await main.settle()
  const state = useAppStore.getState()
  const browser = state.browserTabsByWorktree[EDITOR_PLACEMENT]?.[0]
  expect(browser?.url).toBe('file:///repo/index.html')
  expect(
    state.unifiedTabsByWorktree[EDITOR_PLACEMENT]?.find((tab) => tab.entityId === browser?.id)
  ).toMatchObject({ groupId: 'x-other' })
  expect(state.browserTabsByWorktree[EDITOR_OWNER] ?? []).toEqual([])
})

it('places an SSH document preview in the folder while its document location retains the child', async () => {
  const file = seedEditorPlacementConsumers({
    filePath: '/repo/index.html',
    relativePath: 'index.html',
    language: 'html'
  })
  useAppStore.setState((state) => ({
    repos: state.repos.map((repo) => ({
      ...repo,
      connectionId: 'child-ssh',
      executionHostId: 'ssh:child-ssh'
    })),
    worktreesByRepo: {
      repo1: state.worktreesByRepo.repo1!.map((worktree) => ({
        ...worktree,
        hostId: 'ssh:child-ssh'
      }))
    },
    sshConnectionStates: new Map([
      [
        'child-ssh',
        {
          targetId: 'child-ssh',
          status: 'connected',
          error: null,
          reconnectAttempt: 0,
          connectionGeneration: 1
        }
      ]
    ])
  }))
  main = await drawEditorPlacementConsumers()
  const screen = render(<EditorPanel activeFileId={file.id} activeViewStateId="x-source-tab" />)
  fireEvent.click(screen.getByText('Side preview'))
  await main.settle()
  const state = useAppStore.getState()
  const preview = state.browserTabsByWorktree[EDITOR_PLACEMENT]?.[0]
  expect(preview?.docLocation).toEqual({
    kind: 'workspace-doc',
    worktreeId: EDITOR_OWNER,
    filePath: '/repo/index.html'
  })
  expect(
    state.unifiedTabsByWorktree[EDITOR_PLACEMENT]?.find((tab) => tab.entityId === preview?.id)
      ?.groupId
  ).toBe('x-other')
  expect(state.browserTabsByWorktree[EDITOR_OWNER] ?? []).toEqual([])
})
