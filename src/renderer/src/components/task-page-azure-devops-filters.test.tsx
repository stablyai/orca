// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import type { AzureDevOpsWorkItem } from '../../../shared/azure-devops/boards-types'
import { EMPTY_BACKLOG_FILTERS } from './task-page-azure-devops-backlog-filters'
import {
  TaskPageAzureDevOpsFilters,
  collectAzureDevOpsFilterOptions,
  collectAzureDevOpsViewFilterOptions
} from '@/components/task-page/azure-devops/Filters'

afterEach(() => cleanup())

function item(id: number, overrides: Partial<AzureDevOpsWorkItem>): AzureDevOpsWorkItem {
  return {
    id,
    rev: 1,
    workItemType: 'PBI',
    title: '',
    state: 'New',
    assignedTo: null,
    areaPath: 'P',
    iterationPath: 'P',
    tags: [],
    parentId: null,
    stackRank: id,
    url: '',
    fields: {},
    ...overrides
  }
}

describe('collectAzureDevOpsViewFilterOptions', () => {
  const backlogItems = [item(1, { state: 'Approved', tags: ['web'] })]
  // The board keeps completed cards the backlog drops, so only it knows about Closed.
  const boardItems = [
    item(1, { state: 'Approved', tags: ['web'] }),
    item(2, {
      state: 'Closed',
      tags: ['shipped'],
      assignedTo: { displayName: 'Ada Lovelace', uniqueName: 'ada@contoso', imageUrl: null }
    })
  ]

  it('offers the board items options while the Board view is active', () => {
    const options = collectAzureDevOpsViewFilterOptions({
      view: 'board',
      boardItems,
      workItems: [],
      backlogItems,
      iterations: []
    })
    expect(options.states).toEqual(['Approved', 'Closed'])
    expect(options.tags).toEqual(['shipped', 'web'])
    expect(options.assignees.map((a) => a.key)).toEqual(['unassigned', 'ada@contoso'])
  })

  it('keeps the backlog options for the Backlog view, and until a board page is loaded', () => {
    const backlog = collectAzureDevOpsViewFilterOptions({
      view: 'backlog',
      boardItems,
      workItems: [],
      backlogItems,
      iterations: []
    })
    expect(backlog.states).toEqual(['Approved'])
    expect(backlog.tags).toEqual(['web'])
    const loading = collectAzureDevOpsViewFilterOptions({
      view: 'board',
      boardItems: null,
      workItems: [],
      backlogItems,
      iterations: []
    })
    expect(loading.states).toEqual(['Approved'])
  })
})

describe('collectAzureDevOpsFilterOptions', () => {
  it('collects distinct sorted option values, with Unassigned first', () => {
    const options = collectAzureDevOpsFilterOptions(
      [
        item(1, {
          workItemType: 'Bug',
          state: 'Approved',
          tags: ['b', 'a'],
          assignedTo: { displayName: 'Ada', uniqueName: 'y@x', imageUrl: null }
        }),
        item(2, { workItemType: 'PBI', state: 'New', areaPath: 'P\\Web' })
      ],
      [
        {
          id: 'i',
          name: '2026',
          path: 'P\\2026',
          timeFrame: 'current',
          startDate: null,
          finishDate: null
        }
      ]
    )
    expect(options.workItemTypes).toEqual(['Bug', 'PBI'])
    expect(options.assignees).toEqual([
      { key: 'unassigned', label: 'Unassigned' },
      { key: 'y@x', label: 'Ada' }
    ])
    expect(options.states).toEqual(['Approved', 'New'])
    expect(options.areaPaths).toEqual(['P', 'P\\Web'])
    expect(options.tags).toEqual(['a', 'b'])
    expect(options.iterations).toHaveLength(1)
  })
})

describe('TaskPageAzureDevOpsFilters', () => {
  it('emits keyword changes', () => {
    const onChange = vi.fn()
    render(
      <TaskPageAzureDevOpsFilters
        filters={EMPTY_BACKLOG_FILTERS}
        options={{
          workItemTypes: [],
          assignees: [],
          states: [],
          areaPaths: [],
          iterations: [],
          tags: []
        }}
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByPlaceholderText('Filter by keyword'), {
      target: { value: 'login' }
    })
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_BACKLOG_FILTERS, keyword: 'login' })
  })

  it('selects the current iteration from the shortcut', () => {
    const onChange = vi.fn()
    render(
      <TaskPageAzureDevOpsFilters
        filters={EMPTY_BACKLOG_FILTERS}
        options={{
          workItemTypes: [],
          assignees: [],
          states: [],
          areaPaths: [],
          tags: [],
          iterations: [
            {
              id: 'i',
              name: '2026',
              path: 'P\\2026',
              timeFrame: 'current',
              startDate: null,
              finishDate: null
            }
          ]
        }}
        onChange={onChange}
      />
    )
    const trigger = screen.getByRole('button', { name: /Iteration/ })
    // Radix menus need pointerDown to open in happy-dom
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    fireEvent.click(screen.getByText('Current iteration'))
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_BACKLOG_FILTERS, iterationPath: 'P\\2026' })
  })

  it('keeps the state menu open across several picks', () => {
    const onChange = vi.fn()
    render(
      <TaskPageAzureDevOpsFilters
        filters={EMPTY_BACKLOG_FILTERS}
        options={{
          workItemTypes: [],
          assignees: [],
          states: ['New', 'Approved'],
          areaPaths: [],
          tags: [],
          iterations: []
        }}
        onChange={onChange}
      />
    )
    const trigger = screen.getByRole('button', { name: /State/ })
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'New' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    // Why: the menu is still mounted, so the second pick does not need reopening.
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Approved' }))
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('displays fallback iteration label when option is missing from list', () => {
    render(
      <TaskPageAzureDevOpsFilters
        filters={{ ...EMPTY_BACKLOG_FILTERS, iterationPath: 'P\\Gone' }}
        options={{
          workItemTypes: [],
          assignees: [],
          states: [],
          areaPaths: [],
          tags: [],
          iterations: []
        }}
        onChange={vi.fn()}
      />
    )
    const trigger = screen.getByRole('button', { name: /Iteration/ })
    expect(trigger.textContent).toContain('Gone')
  })
})
