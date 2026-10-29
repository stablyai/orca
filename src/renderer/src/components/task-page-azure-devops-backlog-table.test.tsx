// @vitest-environment happy-dom
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import type { AzureDevOpsWorkItem } from '../../../shared/azure-devops/boards-types'
import {
  AzureDevOpsBacklogTable,
  formatBacklogCell,
  type AzureDevOpsBacklogTableProps
} from '@/components/task-page/azure-devops/BacklogTable'
import type { BacklogRow } from './task-page-azure-devops-backlog-tree'

afterEach(() => cleanup())

function item(id: number, overrides: Partial<AzureDevOpsWorkItem> = {}): AzureDevOpsWorkItem {
  return {
    id,
    rev: 1,
    workItemType: 'Product Backlog Item',
    title: `Item ${id}`,
    state: 'Approved',
    assignedTo: { displayName: 'Ada', uniqueName: 'y@x', imageUrl: null },
    areaPath: 'P\\Web',
    iterationPath: 'P',
    tags: ['triage'],
    parentId: null,
    stackRank: id,
    url: '',
    fields: { 'Microsoft.VSTS.Scheduling.Effort': 3 },
    ...overrides
  }
}

function itemRow(work: AzureDevOpsWorkItem, hasChildren = true): BacklogRow {
  return {
    key: `item:${work.id}`,
    kind: 'item',
    item: work,
    depth: 0,
    hasChildren,
    expanded: false
  }
}

const columnFields = [
  { referenceName: 'System.Title', name: 'Title', width: 400 },
  { referenceName: 'System.State', name: 'State', width: 100 },
  { referenceName: 'Microsoft.VSTS.Scheduling.Effort', name: 'Effort', width: 50 },
  { referenceName: 'System.Tags', name: 'Tags', width: 200 }
]

function renderTable(overrides: Partial<AzureDevOpsBacklogTableProps> = {}) {
  const props: AzureDevOpsBacklogTableProps = {
    rows: [itemRow(item(1))],
    columnFields,
    workItemTypes: {},
    tagColors: {},
    itemById: new Map(),
    onToggleExpand: vi.fn(),
    onOpenItem: vi.fn(),
    onUseItem: vi.fn(),
    ...overrides
  }
  return { ...render(<AzureDevOpsBacklogTable {...props} />), props }
}

describe('formatBacklogCell', () => {
  it('formats identities, numbers, dates and nulls', () => {
    expect(formatBacklogCell('System.AssignedTo', { displayName: 'Ada' })).toBe('Ada')
    expect(formatBacklogCell('Microsoft.VSTS.Scheduling.Effort', 3)).toBe('3')
    expect(
      formatBacklogCell('Microsoft.VSTS.Scheduling.TargetDate', '2026-09-30T00:00:00Z')
    ).toMatch(/2026/)
    expect(formatBacklogCell('System.Tags', null)).toBe('')
  })
})

describe('AzureDevOpsBacklogTable', () => {
  it('renders headers from column fields and one row per item with a state dot and tag chip', () => {
    renderTable({ tagColors: { triage: '#797775' } })
    expect(screen.getByRole('columnheader', { name: 'Effort' })).toBeInTheDocument()
    expect(screen.getByText('Item 1')).toBeInTheDocument()
    expect(screen.getByLabelText('Approved')).toBeInTheDocument()
    expect(screen.getByText('triage')).toHaveStyle({ backgroundColor: '#797775' })
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('lays the grid out from the column widths, letting the title flex', () => {
    renderTable()
    expect(screen.getByRole('grid')).toHaveStyle({
      gridTemplateColumns: '48px minmax(400px, 1fr) 100px 50px 200px'
    })
  })

  it('expands via the chevron and opens via the title', () => {
    const { props } = renderTable()
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    expect(props.onToggleExpand).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByText('Item 1'))
    expect(props.onOpenItem).toHaveBeenCalledWith(1)
  })

  it('renders the Parent column as the hydrated parent title, or the id when unknown', () => {
    const feature = item(70, { workItemType: 'Feature', title: 'Feature 70' })
    const { props } = renderTable({
      rows: [itemRow(item(1, { parentId: 70 }), false), itemRow(item(2, { parentId: 99 }), false)],
      columnFields: [
        { referenceName: 'System.Title', name: 'Title', width: 300 },
        { referenceName: 'System.Parent', name: 'Parent', width: 200 }
      ],
      itemById: new Map([[70, feature]])
    })
    fireEvent.click(screen.getByRole('button', { name: 'Feature 70' }))
    expect(props.onOpenItem).toHaveBeenCalledWith(70)
    expect(screen.getByText('#99')).toBeInTheDocument()
  })

  it('renders a group row with a chevron instead of a band', () => {
    renderTable({
      rows: [{ key: 'unparented', kind: 'group', label: 'Unparented Backlog items', depth: 0 }]
    })
    const label = screen.getByText('Unparented Backlog items')
    expect(label).toBeInTheDocument()
    expect(label.closest('[role="gridcell"]')).not.toHaveClass('bg-muted/40')
  })

  it('offers a resize handle per column that streams pixel widths and reports the drag end', () => {
    const onResizeColumn = vi.fn()
    const onResizeEnd = vi.fn()
    renderTable({ onResizeColumn, onResizeEnd })
    const handles = screen.getAllByRole('separator', { name: 'Resize column' })
    expect(handles).toHaveLength(columnFields.length)
    // Why: happy-dom reports no layout, so the handle starts from the column's stored width.
    fireEvent.mouseDown(handles[1], { button: 0, clientX: 500 })
    fireEvent.mouseMove(document, { clientX: 540 })
    expect(onResizeColumn).toHaveBeenLastCalledWith('System.State', 140)
    fireEvent.mouseMove(document, { clientX: 100 })
    expect(onResizeColumn).toHaveBeenLastCalledWith('System.State', 60)
    fireEvent.mouseUp(document)
    expect(onResizeEnd).toHaveBeenCalledTimes(1)
  })

  it('renders no handles when the table is not resizable', () => {
    renderTable()
    expect(screen.queryAllByRole('separator')).toHaveLength(0)
  })
})
