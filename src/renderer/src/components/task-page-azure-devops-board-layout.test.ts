import { describe, expect, it } from 'vitest'
import type {
  AzureDevOpsBoardColumn,
  AzureDevOpsBoardConfiguration,
  AzureDevOpsBoardRow,
  AzureDevOpsWorkItem,
  AzureDevOpsWorkItemTypeMetadata
} from '../../../shared/azure-devops/boards-types'
import { boardCellKey, buildAzureDevOpsBoardLayout } from './task-page-azure-devops-board-layout'

const COLUMN_FIELD = 'Project.Kanban.Column'
const ROW_FIELD = 'Project.Kanban.Lane'
const DONE_FIELD = 'Project.Kanban.Column.Done'

function column(over: Partial<AzureDevOpsBoardColumn> & { id: string }): AzureDevOpsBoardColumn {
  return {
    name: over.id,
    columnType: 'inProgress',
    itemLimit: 0,
    isSplit: false,
    stateMappings: {},
    description: null,
    ...over
  }
}

function row(id: string, over: Partial<AzureDevOpsBoardRow> = {}): AzureDevOpsBoardRow {
  return { id, name: id, color: null, isDefault: false, ...over }
}

function config(
  columns: AzureDevOpsBoardColumn[],
  rows: AzureDevOpsBoardRow[] = [row('lane-default', { name: '', isDefault: true })]
): AzureDevOpsBoardConfiguration {
  return {
    id: 'board-1',
    name: 'Stories',
    columns,
    rows,
    columnField: COLUMN_FIELD,
    rowField: ROW_FIELD,
    doneField: DONE_FIELD,
    cardFields: {},
    tagColors: {},
    styleRules: []
  }
}

function item(
  id: number,
  fields: Record<string, unknown> = {},
  over: Partial<AzureDevOpsWorkItem> = {}
): AzureDevOpsWorkItem {
  return {
    id,
    rev: 1,
    workItemType: 'User Story',
    title: `Story ${id}`,
    state: 'Active',
    assignedTo: null,
    areaPath: 'Project\\Platform',
    iterationPath: 'Project\\Sprint 1',
    tags: [],
    parentId: null,
    stackRank: null,
    url: `https://dev.azure.com/acme/Project/_workitems/edit/${id}`,
    fields,
    ...over
  }
}

const types: AzureDevOpsWorkItemTypeMetadata[] = [
  {
    name: 'User Story',
    color: null,
    iconId: null,
    iconUrl: null,
    states: [
      { name: 'New', color: null, category: 'Proposed' },
      { name: 'Active', color: null, category: 'InProgress' },
      { name: 'Cut', color: null, category: 'Removed' }
    ]
  }
]

const incoming = column({ id: 'incoming-1', name: 'New', columnType: 'incoming' })
const doing = column({ id: 'inprogress-1', name: 'Active' })
const outgoing = column({ id: 'outgoing-1', name: 'Closed', columnType: 'outgoing' })
const lanes = [
  row('lane-default', { name: '', isDefault: true }),
  row('lane-expedite', { name: 'Expedite' })
]

const build = (c: AzureDevOpsBoardConfiguration, items: AzureDevOpsWorkItem[]) =>
  buildAzureDevOpsBoardLayout({ configuration: c, items, workItemTypes: types })
const idsAt = (layout: ReturnType<typeof build>, col: string, lane: string, done = false) =>
  layout.cellsByKey[boardCellKey(col, lane, done)]?.items.map((i) => i.id)

describe('buildAzureDevOpsBoardLayout', () => {
  it('places cards by column name and lane name', () => {
    const layout = build(config([incoming, doing, outgoing], lanes), [
      item(1, { [COLUMN_FIELD]: 'Active', [ROW_FIELD]: 'Expedite' }),
      item(2, { [COLUMN_FIELD]: 'Active', [ROW_FIELD]: '' })
    ])
    expect(idsAt(layout, 'inprogress-1', 'lane-expedite')).toEqual([1])
    expect(idsAt(layout, 'inprogress-1', 'lane-default')).toEqual([2])
  })

  it('keeps incoming and outgoing columns in a single stack regardless of the item’s lane value', () => {
    const layout = build(config([incoming, doing, outgoing], lanes), [
      item(1, { [COLUMN_FIELD]: 'New', [ROW_FIELD]: 'Expedite' }),
      item(2, { [COLUMN_FIELD]: 'Closed', [ROW_FIELD]: 'Expedite' })
    ])
    expect(idsAt(layout, 'incoming-1', 'lane-default')).toEqual([1])
    expect(idsAt(layout, 'outgoing-1', 'lane-default')).toEqual([2])
    expect(idsAt(layout, 'incoming-1', 'lane-expedite')).toBeUndefined()
  })

  it('sends an item with an empty lane value to the default lane', () => {
    const layout = build(config([doing], lanes), [item(1, { [COLUMN_FIELD]: 'Active' })])
    expect(idsAt(layout, 'inprogress-1', 'lane-default')).toEqual([1])
  })

  it('sends an item whose lane value matches no row to the default lane', () => {
    const layout = build(config([doing], lanes), [
      item(1, { [COLUMN_FIELD]: 'Active', [ROW_FIELD]: 'Deleted lane' })
    ])
    expect(idsAt(layout, 'inprogress-1', 'lane-default')).toEqual([1])
  })

  it('uses the first row as the default lane when no row is marked default', () => {
    const unmarked = [row('lane-a', { name: 'A' }), row('lane-b', { name: 'B' })]
    const layout = build(config([incoming, doing], unmarked), [
      item(1, { [COLUMN_FIELD]: 'Active', [ROW_FIELD]: 'nope' }),
      item(2, { [COLUMN_FIELD]: 'New' })
    ])
    expect(idsAt(layout, 'inprogress-1', 'lane-a')).toEqual([1])
    expect(idsAt(layout, 'incoming-1', 'lane-a')).toEqual([2])
  })

  it('splits a split column by the done field', () => {
    const split = column({ id: 'inprogress-1', name: 'Active', isSplit: true })
    const layout = build(config([split]), [
      item(1, { [COLUMN_FIELD]: 'Active', [DONE_FIELD]: true }),
      item(2, { [COLUMN_FIELD]: 'Active', [DONE_FIELD]: false }),
      item(3, { [COLUMN_FIELD]: 'Active' })
    ])
    expect(idsAt(layout, 'inprogress-1', 'lane-default', true)).toEqual([1])
    expect(idsAt(layout, 'inprogress-1', 'lane-default', false)).toEqual([2, 3])
  })

  it('falls back to the state mapping when the column value names no column', () => {
    const mapped = column({
      id: 'inprogress-2',
      name: 'Review',
      stateMappings: { 'User Story': 'Active' }
    })
    const layout = build(config([incoming, doing, mapped]), [
      item(1, { [COLUMN_FIELD]: 'Gone' }, { state: 'Active' })
    ])
    expect(idsAt(layout, 'inprogress-2', 'lane-default')).toEqual([1])
    expect(layout.unplacedIds).toEqual([])
  })

  it('falls back to the first in-progress column and records the id when nothing matches', () => {
    const layout = build(config([incoming, doing, outgoing]), [
      item(42, { [COLUMN_FIELD]: 'Gone' }, { state: 'Mystery' })
    ])
    expect(layout.unplacedIds).toEqual([42])
    expect(
      layout.cellsByKey[boardCellKey('inprogress-1', 'lane-default', false)]?.items
    ).toHaveLength(1)
  })

  it('renders a board with no in-progress columns', () => {
    const layout = build(config([incoming, outgoing], lanes), [
      item(1, { [COLUMN_FIELD]: 'Gone' }, { state: 'Mystery' }),
      item(2, { [COLUMN_FIELD]: 'Closed' })
    ])
    expect(layout.lanes).toHaveLength(1)
    expect(idsAt(layout, 'incoming-1', 'lane-default')).toEqual([1])
    expect(idsAt(layout, 'outgoing-1', 'lane-default')).toEqual([2])
    expect(layout.unplacedIds).toEqual([1])
  })

  it('drops an item whose state category is Removed', () => {
    const layout = build(config([doing]), [
      item(1, { [COLUMN_FIELD]: 'Active' }, { state: 'Cut' }),
      item(2, { [COLUMN_FIELD]: 'Active' })
    ])
    expect(idsAt(layout, 'inprogress-1', 'lane-default')).toEqual([2])
    expect(layout.columns[0]?.count).toBe(1)
  })

  it('counts a column across lanes and both sub-columns', () => {
    const split = column({ id: 'inprogress-1', name: 'Active', isSplit: true })
    const layout = build(config([split], lanes), [
      item(1, { [COLUMN_FIELD]: 'Active', [ROW_FIELD]: 'Expedite', [DONE_FIELD]: true }),
      item(2, { [COLUMN_FIELD]: 'Active' }),
      item(3, { [COLUMN_FIELD]: 'Active', [DONE_FIELD]: true })
    ])
    expect(layout.columns[0]?.count).toBe(3)
  })

  it('reports no limit when itemLimit is 0', () => {
    const layout = build(config([doing]), [item(1, { [COLUMN_FIELD]: 'Active' })])
    expect(layout.columns[0]?.limit).toBeNull()
    expect(layout.columns[0]?.overLimit).toBe(false)
  })

  it('flags a column over its limit', () => {
    const limited = column({ id: 'inprogress-1', name: 'Active', itemLimit: 1 })
    const layout = build(config([limited]), [
      item(1, { [COLUMN_FIELD]: 'Active' }),
      item(2, { [COLUMN_FIELD]: 'Active' })
    ])
    expect(layout.columns[0]).toMatchObject({ limit: 1, overLimit: true })
  })

  it('does not flag a column exactly at its limit', () => {
    const limited = column({ id: 'inprogress-1', name: 'Active', itemLimit: 2 })
    const layout = build(config([limited]), [
      item(1, { [COLUMN_FIELD]: 'Active' }),
      item(2, { [COLUMN_FIELD]: 'Active' })
    ])
    expect(layout.columns[0]).toMatchObject({ limit: 2, overLimit: false })
  })

  it('sorts a cell by stack rank, then by id, with missing ranks last', () => {
    const rank = 'Microsoft.VSTS.Common.StackRank'
    const layout = build(config([doing]), [
      item(5, { [COLUMN_FIELD]: 'Active' }),
      item(4, { [COLUMN_FIELD]: 'Active', [rank]: 20 }),
      item(3, { [COLUMN_FIELD]: 'Active', [rank]: 10 }),
      item(2, { [COLUMN_FIELD]: 'Active', [rank]: 10 }),
      item(1, { [COLUMN_FIELD]: 'Active' })
    ])
    expect(idsAt(layout, 'inprogress-1', 'lane-default')).toEqual([2, 3, 4, 1, 5])
  })

  it('counts per column for a lane header', () => {
    const layout = build(config([doing, outgoing], lanes), [
      item(1, { [COLUMN_FIELD]: 'Active' }),
      item(2, { [COLUMN_FIELD]: 'Active' }),
      item(3, { [COLUMN_FIELD]: 'Closed' }),
      item(4, { [COLUMN_FIELD]: 'Active', [ROW_FIELD]: 'Expedite' })
    ])
    expect(layout.lanes[0]?.countsByColumnId).toEqual({ 'inprogress-1': 2, 'outgoing-1': 1 })
    expect(layout.lanes[1]?.countsByColumnId).toEqual({ 'inprogress-1': 1 })
  })
})
