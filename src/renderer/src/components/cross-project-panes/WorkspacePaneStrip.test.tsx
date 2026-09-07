// @vitest-environment happy-dom
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { WorkspacePaneStrip } from './WorkspacePaneStrip'
import type { TabBarProps } from '../tab-bar/tab-bar-props'
vi.mock('../tab-group/useTabGroupWorkspaceModel', () => ({
  useTabGroupWorkspaceModel: () => ({ commands: {} })
}))
vi.mock('../tab-bar/TabBar', () => ({
  default: (props: TabBarProps) => (
    <>
      {props.tabs.map((tab, index) => (
        <button key={tab.id} data-id={tab.id} onClick={() => props.onActivate(tab.id)}>
          View {index}
        </button>
      ))}
    </>
  )
}))
afterEach(cleanup)
it('keeps distinct sessions selectable without creating repeated placements', () => {
  useAppStore.setState({
    activeWorktreeId: 'project',
    windowPaneLayout: null,
    unifiedTabsByWorktree: {}
  })
  const state = useAppStore.getState()
  state.createUnifiedTab('project', 'terminal', { executionHostId: 'local', entityId: 'shell' })
  state.createUnifiedTab('project', 'terminal', { executionHostId: 'local', entityId: 'copy' })
  state.initializeWindowPanes()
  const initial = useAppStore.getState().windowPaneLayout!
  const pane = initial.panes[initial.activePaneId]
  render(<WorkspacePaneStrip layout={initial} pane={pane} />)
  expect(new Set(screen.getAllByRole('button').map((button) => button.dataset.id)).size).toBe(2)
  fireEvent.click(screen.getByText('View 1'))
  expect(useAppStore.getState().windowPaneLayout?.panes[pane.id].selectedViewId).toBe(
    initial.views[pane.viewIds[1]].id
  )
})
