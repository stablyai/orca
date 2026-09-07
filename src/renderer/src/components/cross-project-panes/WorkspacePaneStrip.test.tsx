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
it('selects repeated session tabs independently in a combined pane', () => {
  useAppStore.setState({
    activeWorktreeId: 'project',
    windowPaneLayout: null,
    unifiedTabsByWorktree: {}
  })
  const state = useAppStore.getState()
  state.createUnifiedTab('project', 'terminal', { executionHostId: 'local', entityId: 'shell' })
  state.initializeWindowPanes()
  const initial = useAppStore.getState().windowPaneLayout!
  const pane = initial.panes[initial.activePaneId]
  const first = initial.views[pane.selectedViewId!]
  const layout = {
    ...initial,
    views: { ...initial.views, copy: { ...first, id: 'copy' } },
    panes: { [pane.id]: { ...pane, viewIds: [...pane.viewIds, 'copy'] } }
  }
  useAppStore.setState({ windowPaneLayout: layout })
  render(<WorkspacePaneStrip layout={layout} pane={layout.panes[pane.id]} />)
  expect(new Set(screen.getAllByRole('button').map((button) => button.dataset.id)).size).toBe(2)
  fireEvent.click(screen.getByText('View 1'))
  useAppStore.getState().synchronizeWindowPaneSelection()
  expect(useAppStore.getState().windowPaneLayout?.panes[pane.id].selectedViewId).toBe('copy')
})
