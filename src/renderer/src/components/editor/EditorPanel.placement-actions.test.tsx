// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { TabsDrawnFromMain } from '@/store/slices/tabs/tabs-drawn-from-main.test-fixture'
import {
  EDITOR_OWNER,
  EDITOR_PLACEMENT,
  seedEditorPlacementConsumers,
  drawEditorPlacementConsumers
} from '@/store/slices/editor/tabs/editor-placement-consumers.test-fixture'
import type { EditorToggleValue } from './view-mode/EditorViewToggle'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (original) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
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
    onOpenMarkdownPreview
  }: {
    onOpenDiffTargetFile: () => void
    onEditorToggleChange: (mode: EditorToggleValue) => void
    onOpenMarkdownPreview: () => void
  }) => (
    <>
      <button onClick={onOpenDiffTargetFile}>Open</button>
      <button onClick={() => onEditorToggleChange('rich')}>Rich</button>
      <button onClick={onOpenMarkdownPreview}>Markdown preview</button>
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
