import React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  AzureDevOpsBoardConfiguration,
  AzureDevOpsWorkItem,
  AzureDevOpsWorkItemTypeMetadata
} from '../../../../../shared/azure-devops/boards-types'
import {
  boardCellKey,
  type BoardCell,
  type BoardLaneModel,
  type BoardLayout
} from '@/components/task-page-azure-devops-board-layout'
import {
  AzureDevOpsBoardColumnHeaders,
  buildBoardSlots,
  type BoardSlot
} from './BoardColumnHeaders'
import { AzureDevOpsBoardCard } from './BoardCard'
import { AzureDevOpsBoardNotices } from './BoardNotices'

export type AzureDevOpsBoardProps = {
  layout: BoardLayout
  configuration: AzureDevOpsBoardConfiguration
  workItemTypes: AzureDevOpsWorkItemTypeMetadata[]
  parentsById: Record<number, AzureDevOpsWorkItem>
  /** Cards the query returned that the host could not load. */
  unhydratedItemCount: number
  /** Off-board parents that could not be loaded. */
  unhydratedParentCount: number
  collapsedLaneIds: ReadonlySet<string>
  onToggleLane: (laneId: string) => void
  onOpenItem: (id: number) => void
  onUseItem: (item: AzureDevOpsWorkItem) => void
}

const CELL_CLASS = 'flex min-w-0 flex-col gap-1.5 border-l border-border/50 bg-muted/20 p-1.5'

function laneLabel(lane: BoardLaneModel): string {
  return (
    lane.row.name || translate('auto.components.TaskPage.azureDevOps.board.defaultLane', 'Default')
  )
}

function CardStack({
  cell,
  spanLanes,
  gridColumn,
  gridRow,
  props
}: {
  cell: BoardCell | undefined
  spanLanes: boolean
  gridColumn: number
  gridRow: string | number
  props: AzureDevOpsBoardProps
}): React.JSX.Element {
  const items = cell?.items ?? []
  const metadataFor = (typeName: string): AzureDevOpsWorkItemTypeMetadata | null =>
    props.workItemTypes.find((type) => type.name === typeName) ?? null
  return (
    <div
      data-board-cell={cell ? boardCellKey(cell.columnId, cell.laneId, cell.done) : undefined}
      data-board-span={spanLanes ? 'lanes' : undefined}
      className={cn(CELL_CLASS, 'min-h-16')}
      style={{ gridColumn, gridRow }}
    >
      {items.map((item) => {
        const parent = item.parentId === null ? null : (props.parentsById[item.parentId] ?? null)
        return (
          <AzureDevOpsBoardCard
            key={item.id}
            item={item}
            configuration={props.configuration}
            typeMetadata={metadataFor(item.workItemType)}
            parent={parent}
            parentTypeMetadata={parent ? metadataFor(parent.workItemType) : null}
            unplaced={props.layout.unplacedIds.includes(item.id)}
            onOpen={() => props.onOpenItem(item.id)}
            onUse={() => props.onUseItem(item)}
          />
        )
      })}
    </div>
  )
}

function LaneHeader({
  lane,
  layout,
  collapsed,
  gridColumn,
  gridRow,
  onToggleLane
}: {
  lane: BoardLaneModel
  layout: BoardLayout
  collapsed: boolean
  gridColumn: string
  gridRow: number
  onToggleLane: (laneId: string) => void
}): React.JSX.Element {
  const locale = getIntlLocale()
  return (
    <div
      data-board-lane={lane.row.id}
      className="flex min-w-0 items-center gap-2 border-b border-l-2 border-border/50 bg-background px-2 py-1"
      style={{ gridColumn, gridRow, borderLeftColor: lane.row.color ?? undefined }}
    >
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={
          collapsed
            ? translate('auto.components.TaskPage.azureDevOps.board.expandLane', 'Expand swimlane')
            : translate(
                'auto.components.TaskPage.azureDevOps.board.collapseLane',
                'Collapse swimlane'
              )
        }
        onClick={() => onToggleLane(lane.row.id)}
      >
        {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
      </Button>
      <span className="min-w-0 truncate text-xs font-medium">{laneLabel(lane)}</span>
      {collapsed ? (
        <span
          data-board-lane-counts={lane.row.id}
          className="flex min-w-0 flex-wrap items-center gap-2 text-2xs text-muted-foreground"
        >
          {layout.columns
            // Incoming/outgoing cards accumulate under the default lane but stay visible in their
            // spanning stacks, so a collapsed band must only account for the tracks it covers.
            .filter(
              (model) =>
                model.column.columnType === 'inProgress' &&
                (lane.countsByColumnId[model.column.id] ?? 0) > 0
            )
            .map((model) => (
              <span
                key={model.column.id}
                data-board-lane-count={model.column.id}
                className="flex items-center gap-1"
              >
                <span className="truncate">{model.column.name}</span>
                <span className="tabular-nums">
                  {(lane.countsByColumnId[model.column.id] ?? 0).toLocaleString(locale)}
                </span>
              </span>
            ))}
        </span>
      ) : null}
    </div>
  )
}

/** Local track numbers, so each region addresses its own grid columns. */
function regionSlots(slots: BoardSlot[]): BoardSlot[] {
  return slots.map((slot, index) => ({ ...slot, track: index + 1 }))
}

function BoardRegion({
  slots,
  showSubHeaders,
  rows,
  children
}: {
  slots: BoardSlot[]
  showSubHeaders: boolean
  rows: string
  children: React.ReactNode
}): React.JSX.Element | null {
  if (slots.length === 0) {
    return null
  }
  return (
    <div
      className="grid content-start"
      style={{
        gridTemplateColumns: slots.map(() => 'minmax(16rem, 20rem)').join(' '),
        gridTemplateRows: rows
      }}
    >
      <AzureDevOpsBoardColumnHeaders slots={slots} showSubHeaders={showSubHeaders} />
      {children}
    </div>
  )
}

export function AzureDevOpsBoard(props: AzureDevOpsBoardProps): React.JSX.Element {
  const { layout } = props
  const slots = buildBoardSlots(layout.columns)
  const anySplit = layout.columns.some((model) => model.column.isSplit)
  const firstInProgress = slots.findIndex((slot) => slot.model.column.columnType === 'inProgress')
  const lastInProgress = slots.findLastIndex(
    (slot) => slot.model.column.columnType === 'inProgress'
  )
  // Why three regions: swimlanes partition only the in-progress span. One grid for all of them would
  // spread each incoming/outgoing stack's height across every lane row it covers.
  const leading = regionSlots(firstInProgress === -1 ? slots : slots.slice(0, firstInProgress))
  const spanning = regionSlots(
    firstInProgress === -1 ? [] : slots.slice(firstInProgress, lastInProgress + 1)
  )
  const trailing = regionSlots(firstInProgress === -1 ? [] : slots.slice(lastInProgress + 1))
  const lanes = spanning.length === 0 ? [] : layout.lanes
  const defaultLaneId =
    layout.lanes.find((lane) => lane.row.isDefault)?.row.id ?? layout.lanes[0]?.row.id ?? 'default'
  const headerRows = anySplit ? 'auto auto' : 'auto'
  const bodyStart = anySplit ? 3 : 2
  const laneRows = lanes.length === 0 ? '1fr' : lanes.map(() => 'min-content min-content').join(' ')
  const sideStack = (slot: BoardSlot): React.JSX.Element => (
    <CardStack
      key={`${slot.model.column.id}-${slot.done}`}
      cell={layout.cellsByKey[boardCellKey(slot.model.column.id, defaultLaneId, slot.done)]}
      spanLanes
      gridColumn={slot.track}
      gridRow={bodyStart}
      props={props}
    />
  )
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <AzureDevOpsBoardNotices
        unplacedCount={layout.unplacedIds.length}
        unhydratedItemCount={props.unhydratedItemCount}
        unhydratedParentCount={props.unhydratedParentCount}
      />
      <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
        <div className="flex w-max min-w-full items-stretch text-[13px]">
          <BoardRegion slots={leading} showSubHeaders={anySplit} rows={`${headerRows} 1fr`}>
            {leading.map(sideStack)}
          </BoardRegion>
          <BoardRegion
            slots={spanning}
            showSubHeaders={anySplit}
            rows={`${headerRows} ${laneRows}`}
          >
            {lanes.map((lane, index) => {
              const collapsed = props.collapsedLaneIds.has(lane.row.id)
              const headerRow = bodyStart + index * 2
              return (
                <React.Fragment key={lane.row.id}>
                  <LaneHeader
                    lane={lane}
                    layout={layout}
                    collapsed={collapsed}
                    gridColumn={`1 / ${spanning.length + 1}`}
                    gridRow={headerRow}
                    onToggleLane={props.onToggleLane}
                  />
                  {collapsed
                    ? null
                    : spanning.map((slot) => (
                        <CardStack
                          key={`${slot.model.column.id}-${slot.done}-${lane.row.id}`}
                          cell={
                            layout.cellsByKey[
                              boardCellKey(slot.model.column.id, lane.row.id, slot.done)
                            ]
                          }
                          spanLanes={false}
                          gridColumn={slot.track}
                          gridRow={headerRow + 1}
                          props={props}
                        />
                      ))}
                </React.Fragment>
              )
            })}
            {lanes.length === 0 ? spanning.map(sideStack) : null}
          </BoardRegion>
          <BoardRegion slots={trailing} showSubHeaders={anySplit} rows={`${headerRows} 1fr`}>
            {trailing.map(sideStack)}
          </BoardRegion>
        </div>
      </div>
    </div>
  )
}
