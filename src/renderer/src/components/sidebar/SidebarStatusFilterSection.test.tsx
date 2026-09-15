// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import SidebarStatusFilterSection, {
  toggleWorkspaceStatusFilter
} from './SidebarStatusFilterSection'
import { cloneDefaultWorkspaceStatuses } from '../../../../shared/workspace-statuses'

const catalog = cloneDefaultWorkspaceStatuses()
const initialState = useAppStore.getInitialState()

function renderSection() {
  return render(
    <DropdownMenu open>
      <DropdownMenuContent forceMount>
        <SidebarStatusFilterSection />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

beforeEach(() => {
  useAppStore.setState({ workspaceStatuses: catalog, filterWorkspaceStatuses: [] }, false)
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('toggleWorkspaceStatusFilter', () => {
  it('adds a status and keeps catalog order regardless of insertion order', () => {
    const afterDone = toggleWorkspaceStatusFilter([], 'completed', catalog)
    expect(afterDone).toEqual(['completed'])
    // Adding Todo (first column) must sort ahead of the already-selected Done.
    expect(toggleWorkspaceStatusFilter(afterDone, 'todo', catalog)).toEqual(['todo', 'completed'])
  })

  it('removes a selected status, leaving the rest in catalog order', () => {
    expect(toggleWorkspaceStatusFilter(['todo', 'completed'], 'todo', catalog)).toEqual([
      'completed'
    ])
  })

  it('drops ids no longer present in the catalog', () => {
    expect(toggleWorkspaceStatusFilter(['ghost', 'completed'], 'todo', catalog)).toEqual([
      'todo',
      'completed'
    ])
  })
})

describe('SidebarStatusFilterSection', () => {
  it('shows the all-statuses label with nothing selected', () => {
    const view = renderSection()
    expect(view.baseElement.textContent).toContain('All statuses')
  })

  it('reflects a single selection with the status label', () => {
    act(() => useAppStore.setState({ filterWorkspaceStatuses: ['completed'] }, false))
    const view = renderSection()
    // The sub-trigger shows the sole selected status label ("Done"), not a count.
    expect(view.baseElement.textContent).toContain('Done')
  })

  it('reflects a multi selection with a count label', () => {
    act(() => useAppStore.setState({ filterWorkspaceStatuses: ['todo', 'completed'] }, false))
    const view = renderSection()
    expect(view.baseElement.textContent).toContain('2 statuses')
  })

  it('renders nothing when the catalog is empty', () => {
    act(() => useAppStore.setState({ workspaceStatuses: [] }, false))
    const view = renderSection()
    expect(view.baseElement.textContent).not.toContain('All statuses')
  })
})
