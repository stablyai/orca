import type {
  AzureDevOpsBoardColumn,
  AzureDevOpsBoardConfiguration,
  AzureDevOpsBoardRow,
  AzureDevOpsWorkItem,
  AzureDevOpsWorkItemTypeMetadata
} from '../../../shared/azure-devops/boards-types'

export type BoardCell = {
  columnId: string
  laneId: string
  done: boolean
  items: AzureDevOpsWorkItem[]
}

export type BoardColumnModel = {
  column: AzureDevOpsBoardColumn
  /** Cards in the column across every lane and sub-column. */
  count: number
  /** null when itemLimit is 0: the spec says 0 means no counter. */
  limit: number | null
  overLimit: boolean
}

export type BoardLaneModel = {
  row: AzureDevOpsBoardRow
  /** Only columns holding at least one card of this lane appear. */
  countsByColumnId: Record<string, number>
}

export type BoardLayout = {
  columns: BoardColumnModel[]
  lanes: BoardLaneModel[]
  /** Keyed by `${columnId}|${laneId}|${done ? 'done' : 'doing'}`. */
  cellsByKey: Record<string, BoardCell>
  /** Ids placed by fallback because their column value matched nothing. */
  unplacedIds: number[]
}

const STACK_RANK_FIELD = 'Microsoft.VSTS.Common.StackRank'
const SYNTHETIC_DEFAULT_ROW: AzureDevOpsBoardRow = {
  id: 'default',
  name: '',
  color: null,
  isDefault: true
}

export function boardCellKey(columnId: string, laneId: string, done: boolean): string {
  return `${columnId}|${laneId}|${done ? 'done' : 'doing'}`
}

function isRemoved(
  item: AzureDevOpsWorkItem,
  categories: Map<string, Map<string, string>>
): boolean {
  return categories.get(item.workItemType)?.get(item.state) === 'Removed'
}

function rankOf(item: AzureDevOpsWorkItem): number | null {
  const rank = item.fields[STACK_RANK_FIELD]
  return typeof rank === 'number' ? rank : null
}

function compareCards(a: AzureDevOpsWorkItem, b: AzureDevOpsWorkItem): number {
  const rankA = rankOf(a)
  const rankB = rankOf(b)
  if (rankA !== rankB) {
    if (rankA === null) {
      return 1
    }
    if (rankB === null) {
      return -1
    }
    return rankA - rankB
  }
  return a.id - b.id
}

function resolveColumn(
  item: AzureDevOpsWorkItem,
  config: AzureDevOpsBoardConfiguration
): { column: AzureDevOpsBoardColumn; unplaced: boolean } | null {
  const value = item.fields[config.columnField]
  const byName = config.columns.find((c) => c.name === value)
  if (byName) {
    return { column: byName, unplaced: false }
  }
  const byState = config.columns.find((c) => c.stateMappings[item.workItemType] === item.state)
  if (byState) {
    return { column: byState, unplaced: false }
  }
  const fallback = config.columns.find((c) => c.columnType === 'inProgress') ?? config.columns[0]
  return fallback ? { column: fallback, unplaced: true } : null
}

export function buildAzureDevOpsBoardLayout(input: {
  configuration: AzureDevOpsBoardConfiguration
  items: AzureDevOpsWorkItem[]
  workItemTypes: AzureDevOpsWorkItemTypeMetadata[]
}): BoardLayout {
  const { configuration: config } = input
  const categories = new Map(
    input.workItemTypes.map((t) => [t.name, new Map(t.states.map((s) => [s.name, s.category]))])
  )
  const rows = config.rows.length > 0 ? config.rows : [SYNTHETIC_DEFAULT_ROW]
  const defaultRow = rows.find((r) => r.isDefault) ?? rows[0] ?? SYNTHETIC_DEFAULT_ROW

  const cellsByKey: Record<string, BoardCell> = {}
  for (const column of config.columns) {
    // Swimlanes partition only in-progress columns; the others are one stack.
    const columnRows = column.columnType === 'inProgress' ? rows : [defaultRow]
    for (const lane of columnRows) {
      for (const done of column.isSplit ? [false, true] : [false]) {
        cellsByKey[boardCellKey(column.id, lane.id, done)] = {
          columnId: column.id,
          laneId: lane.id,
          done,
          items: []
        }
      }
    }
  }

  // Without an in-progress column there is nothing to partition.
  const laneRows = config.columns.some((c) => c.columnType === 'inProgress') ? rows : [defaultRow]
  const unplacedIds: number[] = []
  const counts = new Map<string, number>()
  const laneCounts = new Map<string, Record<string, number>>(rows.map((r) => [r.id, {}]))
  for (const item of input.items) {
    if (isRemoved(item, categories)) {
      continue
    }
    const resolved = resolveColumn(item, config)
    if (!resolved) {
      continue
    }
    const { column } = resolved
    if (resolved.unplaced) {
      unplacedIds.push(item.id)
    }
    const laneValue = item.fields[config.rowField]
    const lane =
      column.columnType === 'inProgress'
        ? (rows.find((r) => r.name === laneValue && laneValue !== '') ?? defaultRow)
        : defaultRow
    const done = column.isSplit && item.fields[config.doneField] === true
    cellsByKey[boardCellKey(column.id, lane.id, done)]?.items.push(item)
    counts.set(column.id, (counts.get(column.id) ?? 0) + 1)
    const perLane = laneCounts.get(lane.id)
    if (perLane) {
      perLane[column.id] = (perLane[column.id] ?? 0) + 1
    }
  }

  for (const cell of Object.values(cellsByKey)) {
    cell.items.sort(compareCards)
  }

  return {
    columns: config.columns.map((column) => {
      const count = counts.get(column.id) ?? 0
      const limit = column.itemLimit > 0 ? column.itemLimit : null
      return { column, count, limit, overLimit: limit !== null && count > limit }
    }),
    lanes: laneRows.map((row) => ({ row, countsByColumnId: laneCounts.get(row.id) ?? {} })),
    cellsByKey,
    unplacedIds
  }
}
