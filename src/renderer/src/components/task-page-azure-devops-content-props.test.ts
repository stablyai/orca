import { describe, expect, it, vi } from 'vitest'
import type {
  AzureDevOpsBacklogLevel,
  AzureDevOpsBoardPage,
  AzureDevOpsWorkItem,
  AzureDevOpsWorkItemTypeMetadata
} from '../../../shared/azure-devops/boards-types'
import { buildAzureDevOpsContentProps } from './task-page-azure-devops-content-props'
import { boardCellKey } from './task-page-azure-devops-board-layout'
import {
  EMPTY_BACKLOG_FILTERS,
  type BacklogFilters
} from './task-page-azure-devops-backlog-filters'
import type { AzureDevOpsTaskView } from './task-page-azure-devops-team-selection-persistence'

const COLUMN_FIELD = 'WEF_1_Kanban.Column'
const LANE_FIELD = 'WEF_1_Kanban.Lane'
const DONE_FIELD = 'WEF_1_Kanban.Column.Done'

const level: AzureDevOpsBacklogLevel = {
  id: 'Microsoft.RequirementCategory',
  name: 'Backlog items',
  rank: 2,
  kind: 'requirement',
  workItemTypes: ['Product Backlog Item'],
  columnFields: [],
  hidden: false
}

const workItemTypes: Record<string, AzureDevOpsWorkItemTypeMetadata> = {
  'Product Backlog Item': {
    name: 'Product Backlog Item',
    color: '#009CCC',
    iconId: 'icon_list',
    iconUrl: null,
    states: [{ name: 'Approved', color: '#b2b2b2', category: 'Proposed' }]
  }
}

function item(
  id: number,
  overrides: Partial<AzureDevOpsWorkItem> = {},
  fields: Record<string, unknown> = {}
): AzureDevOpsWorkItem {
  return {
    id,
    rev: 1,
    workItemType: 'Product Backlog Item',
    title: `Item ${id}`,
    state: 'Approved',
    assignedTo: null,
    areaPath: 'Project\\Web',
    iterationPath: 'Project',
    tags: [],
    parentId: null,
    stackRank: id,
    url: '',
    fields: { 'System.Title': `Item ${id}`, [COLUMN_FIELD]: 'Active', ...fields },
    ...overrides
  }
}

function boardPage(overrides: Partial<AzureDevOpsBoardPage> = {}): AzureDevOpsBoardPage {
  return {
    level,
    configuration: {
      id: 'board-1',
      name: 'Stories',
      columns: [
        {
          id: 'c1',
          name: 'Active',
          columnType: 'inProgress',
          itemLimit: 0,
          isSplit: false,
          stateMappings: {},
          description: null
        }
      ],
      rows: [],
      columnField: COLUMN_FIELD,
      rowField: LANE_FIELD,
      doneField: DONE_FIELD,
      cardFields: {},
      tagColors: {},
      styleRules: []
    },
    items: [item(101), item(102, { title: 'Ignore me' })],
    parents: [item(900, { workItemType: 'Product Backlog Item', title: 'Offboard parent' })],
    ...overrides
  }
}

function props(
  overrides: {
    view?: AzureDevOpsTaskView
    board?: AzureDevOpsBoardPage | null
    filters?: BacklogFilters
    boardAvailable?: boolean
    workItems?: AzureDevOpsWorkItem[]
  } = {}
) {
  return buildAzureDevOpsContentProps({
    status: 'ready',
    errorMessage: null,
    projectLabel: 'acme/Project',
    workItems: overrides.workItems ?? [],
    workItemsUnhydratedItemCount: 0,
    workItemsTruncatedAtQueryLimit: null,
    workItemsErrorStatus: null,
    workItemsErrorMessage: null,
    workItemsLoading: false,
    teams: [],
    teamName: 'Platform',
    selectTeam: vi.fn(),
    visibleLevels: [level],
    levelId: level.id,
    setLevelId: vi.fn(),
    setPage: vi.fn(),
    setToggled: vi.fn(),
    showParents: false,
    setShowParents: vi.fn(),
    showInProgress: true,
    setShowInProgress: vi.fn(),
    columnWidths: {
      columns: [],
      hasOverrides: false,
      onResizeColumn: vi.fn(),
      onResizeEnd: vi.fn(),
      resetColumnWidths: vi.fn()
    },
    refresh: vi.fn(),
    refreshing: false,
    filters: overrides.filters ?? EMPTY_BACKLOG_FILTERS,
    setFilters: vi.fn(),
    filterOptions: {
      workItemTypes: [],
      assignees: [],
      states: [],
      areaPaths: [],
      iterations: [],
      tags: []
    },
    rows: [],
    itemById: new Map(),
    workItemTypes,
    view: overrides.view ?? 'board',
    selectView: vi.fn(),
    boardAvailable: overrides.boardAvailable ?? true,
    boardPage: overrides.board === undefined ? boardPage() : overrides.board,
    boardErrorStatus: null,
    boardErrorMessage: null,
    collapsedLaneIds: new Set<string>(),
    onToggleLane: vi.fn(),
    detailId: null,
    setDetailId: vi.fn(),
    detail: null,
    detailLoading: false,
    detailError: null,
    parent: null,
    childItems: [],
    backlogUnhydratedItemCount: 0,
    useItem: vi.fn()
  })
}

describe('buildAzureDevOpsContentProps', () => {
  it('builds the board layout from the loaded page and the active filters', () => {
    const built = props({ filters: { ...EMPTY_BACKLOG_FILTERS, keyword: 'Item 101' } })
    expect(built.view).toBe('board')
    expect(built.toolbar.view).toBe('board')
    expect(built.toolbar.boardAvailable).toBe(true)
    const board = built.board
    expect(board).not.toBeNull()
    expect(board?.layout.cellsByKey[boardCellKey('c1', 'default', false)]?.items).toHaveLength(1)
    expect(board?.layout.cellsByKey[boardCellKey('c1', 'default', false)]?.items[0].id).toBe(101)
    expect(board?.layout.columns[0].count).toBe(1)
  })

  it('looks parents up in the board items as well as the offboard parents', () => {
    const built = props()
    expect(Object.keys(built.board?.parentsById ?? {}).sort()).toEqual(['101', '102', '900'])
    expect(built.board?.workItemTypes.map((type) => type.name)).toEqual(['Product Backlog Item'])
  })

  it('carries the host’s hydration shortfall to the board', () => {
    const built = props({
      board: boardPage({ unhydratedItemCount: 3, unhydratedParentCount: 1 })
    })
    expect(built.board?.unhydratedItemCount).toBe(3)
    expect(built.board?.unhydratedParentCount).toBe(1)
    // An older host sends neither count.
    const older = props()
    expect(older.board?.unhydratedItemCount).toBe(0)
    expect(older.board?.unhydratedParentCount).toBe(0)
  })

  it('builds no board props for the Backlog view, nor before a board page is loaded', () => {
    // A loaded page must not cost a layout build while the table is what is on screen.
    expect(props({ view: 'backlog' }).board).toBeNull()
    expect(props({ board: null }).board).toBeNull()
  })

  it('builds flat Work items rows in the host’s order, with no tree and no expansion', () => {
    const built = props({ view: 'workItems', workItems: [item(7), item(3)] })
    expect(built.workItems.table.rows.map((row) => row.key)).toEqual(['item:7', 'item:3'])
    expect(built.workItems.table.rows.every((row) => row.kind === 'item' && !row.hasChildren)).toBe(
      true
    )
    expect(built.workItems.table.columnFields.map((c) => c.referenceName)).toEqual([
      'System.Id',
      'System.Title',
      'System.State',
      'System.AreaPath',
      'System.ChangedDate'
    ])
    expect(built.workItems.totalItemCount).toBe(2)
  })

  it('filters the Work items list locally, keeping the unfiltered total for the empty state', () => {
    const built = props({
      view: 'workItems',
      workItems: [item(7), item(3, { title: 'Needle' })],
      filters: { ...EMPTY_BACKLOG_FILTERS, keyword: 'Needle' }
    })
    expect(built.workItems.table.rows.map((row) => row.key)).toEqual(['item:3'])
    expect(built.workItems.totalItemCount).toBe(2)
  })
})
