// @vitest-environment happy-dom
import { cleanup, render, screen, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { WorkspaceEditorSurfaces } from './WorkspaceEditorSurfaces'
vi.mock('../editor/EditorPanel', () => ({
  default: ({
    activeFileId,
    activeViewStateId,
    isVisible
  }: {
    activeFileId: string
    activeViewStateId: string
    isVisible: boolean
  }) => (
    <div
      data-testid="editor-view"
      data-file={activeFileId}
      data-view={activeViewStateId}
      data-visible={isVisible}
    />
  )
}))
afterEach(cleanup)
it('renders repeated editor views with independent view identity and the same backing file', async () => {
  useAppStore.setState({ activeWorktreeId: 'project', windowPaneLayout: null })
  const state = useAppStore.getState()
  state.createUnifiedTab('project', 'editor', { executionHostId: 'local', entityId: 'draft' })
  state.initializeWindowPanes()
  render(<WorkspaceEditorSurfaces worktreeId="project" isVisible />)
  await screen.findByTestId('editor-view')
  act(() => state.openAnotherWorkspaceView(useAppStore.getState().windowPaneLayout!.activePaneId))
  const views = await screen.findAllByTestId('editor-view')
  expect(views).toHaveLength(2)
  expect(new Set(views.map((view) => view.dataset.view)).size).toBe(2)
  expect(
    views.every((view) => view.dataset.file === 'draft' && view.dataset.visible === 'true')
  ).toBe(true)
})
