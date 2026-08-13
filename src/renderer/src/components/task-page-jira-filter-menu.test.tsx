// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import type { JiraSavedFilter } from '../../../shared/types'
import type { ActiveJiraFilterRef, JiraCustomFilter } from '../../../shared/jira-custom-filters'
import { TaskPageJiraFilterMenu } from './task-page-jira-filter-menu'

// Radix menus/dialogs need real pointer events; render their content inline so
// the menu behavior stays testable in happy-dom (same approach as other menu tests).
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect
  }: {
    children: ReactNode
    onSelect?: (event: Event) => void
  }) => (
    <div role="menuitem" tabIndex={0} onClick={() => onSelect?.(new Event('menu.itemSelect'))}>
      {children}
    </div>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>
}))

afterEach(cleanup)

const savedFilter: JiraSavedFilter = {
  id: '10001',
  name: 'Team backlog',
  jql: 'project = ALP ORDER BY rank',
  siteId: 'site-1',
  siteName: 'Example Jira'
}

const customFilter: JiraCustomFilter = {
  id: 'custom-1',
  name: 'My open bugs',
  jql: 'type = Bug AND resolution = Unresolved'
}

type MenuProps = Parameters<typeof TaskPageJiraFilterMenu>[0]

function renderMenu(overrides: Partial<MenuProps> = {}): MenuProps {
  const props: MenuProps = {
    savedFilters: [savedFilter],
    savedFiltersLoading: false,
    customFilters: [customFilter],
    activeFilter: null,
    showSiteName: false,
    onSelectSaved: vi.fn(),
    onSelectCustom: vi.fn(),
    onCreateCustom: vi.fn(),
    onUpdateCustom: vi.fn(),
    onDeleteCustom: vi.fn(),
    ...overrides
  }
  render(<TaskPageJiraFilterMenu {...props} />)
  return props
}

describe('TaskPage Jira filter menu', () => {
  it('lists saved and custom filters and reports selections', async () => {
    const user = userEvent.setup()
    const props = renderMenu()

    await user.click(screen.getByText('Team backlog'))
    expect(props.onSelectSaved).toHaveBeenCalledWith(savedFilter)

    await user.click(screen.getByText('My open bugs'))
    expect(props.onSelectCustom).toHaveBeenCalledWith(customFilter)
  })

  it('shows the active filter name on the trigger', () => {
    const activeFilter: ActiveJiraFilterRef = {
      source: 'saved',
      siteId: savedFilter.siteId,
      filterId: savedFilter.id,
      name: savedFilter.name,
      jql: savedFilter.jql
    }
    renderMenu({ activeFilter })
    expect(screen.getAllByText('Team backlog').length).toBeGreaterThan(1)
    expect(screen.queryByText('Filters')).not.toBeInTheDocument()
  })

  it('shows site names only for the all-sites selection', () => {
    renderMenu({ showSiteName: true })
    expect(screen.getByText('Example Jira')).toBeInTheDocument()

    cleanup()
    renderMenu({ showSiteName: false })
    expect(screen.queryByText('Example Jira')).not.toBeInTheDocument()
  })

  it('shows an empty state when Jira has no saved filters', () => {
    renderMenu({ savedFilters: [] })
    expect(screen.getByText('No saved filters')).toBeInTheDocument()

    cleanup()
    renderMenu({ savedFilters: [], savedFiltersLoading: true })
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('creates a custom filter through the dialog', async () => {
    const user = userEvent.setup()
    const props = renderMenu()

    await user.click(screen.getByText('New custom filter…'))
    const saveButton = screen.getByRole('button', { name: 'Save' })
    expect(saveButton).toBeDisabled()

    await user.type(screen.getByLabelText('Name'), '  Blocked issues ')
    await user.type(screen.getByLabelText('JQL'), ' status = Blocked ')
    await user.click(saveButton)

    expect(props.onCreateCustom).toHaveBeenCalledWith({
      name: 'Blocked issues',
      jql: 'status = Blocked'
    })
  })

  it('prefills the new-filter JQL from the current search', async () => {
    const user = userEvent.setup()
    renderMenu({ initialJql: 'project = ALP' })

    await user.click(screen.getByText('New custom filter…'))
    expect(screen.getByLabelText('JQL')).toHaveValue('project = ALP')
  })

  it('edits a custom filter without selecting it', async () => {
    const user = userEvent.setup()
    const props = renderMenu()

    await user.click(screen.getByRole('button', { name: 'Edit filter “My open bugs”' }))
    expect(props.onSelectCustom).not.toHaveBeenCalled()

    const nameInput = screen.getByLabelText('Name')
    expect(nameInput).toHaveValue('My open bugs')
    await user.clear(nameInput)
    await user.type(nameInput, 'Renamed')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(props.onUpdateCustom).toHaveBeenCalledWith('custom-1', {
      name: 'Renamed',
      jql: customFilter.jql
    })
  })

  it('deletes a custom filter without selecting it', async () => {
    const user = userEvent.setup()
    const props = renderMenu()

    await user.click(screen.getByRole('button', { name: 'Delete filter “My open bugs”' }))
    expect(props.onDeleteCustom).toHaveBeenCalledWith('custom-1')
    expect(props.onSelectCustom).not.toHaveBeenCalled()
  })
})
