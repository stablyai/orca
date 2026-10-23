// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { AutomationListTableHeader } from './AutomationListTableHeader'

describe('AutomationListTableHeader', () => {
  afterEach(cleanup)

  it('renders all expected columns', () => {
    render(<AutomationListTableHeader />)

    expect(screen.getByText('Name')).toBeDefined()
    expect(screen.getByText('Schedule')).toBeDefined()
    expect(screen.getByText('Project')).toBeDefined()
    expect(screen.getByText('Host')).toBeDefined()
    expect(screen.getByText('Next run')).toBeDefined()
    expect(screen.getByText('Last run')).toBeDefined()
    expect(screen.getByText('Status')).toBeDefined()
    expect(screen.getByText('Agent')).toBeDefined()
    expect(screen.getByText('Actions')).toBeDefined()
  })
})

describe('AutomationListTableHeader sorting', () => {
  afterEach(cleanup)

  it('exposes only the orderable columns as buttons', () => {
    render(<AutomationListTableHeader sort={null} onSort={() => {}} />)

    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Name',
      'Last run'
    ])
  })

  it('reports the sorted column and direction in the accessible name', () => {
    const { rerender } = render(
      <AutomationListTableHeader sort={{ field: 'name', direction: 'asc' }} onSort={() => {}} />
    )
    expect(screen.getByRole('button', { name: 'Name, sorted ascending' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Last run' })).toBeDefined()

    rerender(
      <AutomationListTableHeader sort={{ field: 'lastRun', direction: 'desc' }} onSort={() => {}} />
    )
    expect(screen.getByRole('button', { name: 'Last run, sorted descending' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Name' })).toBeDefined()
  })

  it('requests a sort for the clicked column', async () => {
    const onSort = vi.fn()
    render(<AutomationListTableHeader sort={null} onSort={onSort} />)

    await userEvent.click(screen.getByRole('button', { name: 'Last run' }))

    expect(onSort.mock.calls).toEqual([['lastRun']])
  })

  it('stays non-interactive when the list cannot be sorted', () => {
    render(<AutomationListTableHeader />)

    expect(screen.queryAllByRole('button')).toEqual([])
  })
})
