import { useEffect, useMemo, useRef } from 'react'
import type { ClickUpTask } from '../../../shared/clickup-types'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  GANTT_DAY_WIDTH,
  buildClickUpGanttLayout,
  buildClickUpGanttTicks,
  type GanttBar
} from './clickup-gantt-model'
import { clickUpTaskReference } from './clickup-task-page-model'
import type { ClickUpGanttGroupBy, ClickUpGanttZoom } from './clickup-task-view-preferences'

const LABEL_WIDTH = 240
const ROW_HEIGHT = 28

function barTitle(bar: GanttBar): string {
  const dates = [bar.task.startDate, bar.task.dueDate]
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).toLocaleDateString())
    .join(' → ')
  return `${clickUpTaskReference(bar.task)} ${bar.task.name}${dates ? ` (${dates})` : ''}`
}

// Read-only timeline of the filtered tasks: start→due bars, due-only
// milestones, and an Unscheduled group for tasks with neither date.
export function ClickUpTaskGantt({
  tasks,
  zoom,
  groupBy,
  onZoomChange,
  onGroupByChange,
  onOpenTask
}: {
  tasks: readonly ClickUpTask[]
  zoom: ClickUpGanttZoom
  groupBy: ClickUpGanttGroupBy
  onZoomChange: (zoom: ClickUpGanttZoom) => void
  onGroupByChange: (groupBy: ClickUpGanttGroupBy) => void
  onOpenTask: (task: ClickUpTask) => void
}): React.JSX.Element {
  const layout = useMemo(() => buildClickUpGanttLayout(tasks, groupBy), [groupBy, tasks])
  const ticks = useMemo(
    () => buildClickUpGanttTicks(layout.rangeStart, layout.totalDays, zoom),
    [layout.rangeStart, layout.totalDays, zoom]
  )
  const dayWidth = GANTT_DAY_WIDTH[zoom]
  const timelineWidth = layout.totalDays * dayWidth
  const scrollRef = useRef<HTMLDivElement>(null)

  // Why: open on today rather than on the earliest bar, which may be months back.
  useEffect(() => {
    const element = scrollRef.current
    if (element && layout.todayOffset !== null) {
      element.scrollLeft = Math.max(0, layout.todayOffset * dayWidth - element.clientWidth / 3)
    }
  }, [dayWidth, layout.todayOffset])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <ToggleGroup
          type="single"
          value={zoom}
          onValueChange={(value) => {
            if (value === 'day' || value === 'week') {
              onZoomChange(value)
            }
          }}
          aria-label={translate('auto.components.clickup.gantt.zoom', 'Timeline zoom')}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="day">
            {translate('auto.components.clickup.gantt.day', 'Day')}
          </ToggleGroupItem>
          <ToggleGroupItem value="week">
            {translate('auto.components.clickup.gantt.week', 'Week')}
          </ToggleGroupItem>
        </ToggleGroup>
        <Select
          value={groupBy}
          onValueChange={(value) => {
            if (value === 'list' || value === 'status') {
              onGroupByChange(value)
            }
          }}
        >
          <SelectTrigger className="h-8 w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="list">
              {translate('auto.components.clickup.gantt.groupList', 'Group by List')}
            </SelectItem>
            <SelectItem value="status">
              {translate('auto.components.clickup.gantt.groupStatus', 'Group by status')}
            </SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">
          {translate(
            'auto.components.clickup.gantt.summary',
            '{{scheduled}} scheduled, {{unscheduled}} unscheduled',
            {
              scheduled: tasks.length - layout.unscheduled.length,
              unscheduled: layout.unscheduled.length
            }
          )}
        </span>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
        <div className="relative" style={{ width: LABEL_WIDTH + timelineWidth }}>
          <div className="sticky top-0 z-20 flex h-7 border-b border-border bg-muted">
            <div
              className="sticky left-0 z-30 shrink-0 border-r border-border bg-muted"
              style={{ width: LABEL_WIDTH }}
            />
            <div className="relative" style={{ width: timelineWidth }}>
              {ticks.map((tick) => (
                <span
                  key={tick.offset}
                  className={cn(
                    'absolute top-1.5 whitespace-nowrap pl-1 text-[10px] text-muted-foreground',
                    tick.major && 'font-medium text-foreground'
                  )}
                  style={{ left: tick.offset * dayWidth }}
                >
                  {tick.label}
                </span>
              ))}
            </div>
          </div>
          {layout.todayOffset !== null ? (
            <div
              aria-hidden
              className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-destructive"
              style={{ left: LABEL_WIDTH + layout.todayOffset * dayWidth + dayWidth / 2 }}
            />
          ) : null}
          {layout.groups.map((group) => (
            <div key={group.key}>
              {/* Why: sticky only pins the inner label; a full-width row cannot stick. */}
              <div className="h-7 border-b border-border bg-muted/50">
                <div className="sticky left-0 flex h-full w-fit items-center gap-2 px-3 text-xs font-medium text-foreground">
                  {group.color ? (
                    <span
                      aria-hidden
                      className="size-2 rounded-full"
                      style={{ backgroundColor: group.color }}
                    />
                  ) : null}
                  {group.label}
                  <span className="text-muted-foreground">{group.bars.length}</span>
                </div>
              </div>
              {group.bars.map((bar) => (
                <div
                  key={bar.task.id}
                  className="flex border-b border-border/60"
                  style={{ height: ROW_HEIGHT }}
                >
                  <button
                    type="button"
                    onClick={() => onOpenTask(bar.task)}
                    className="sticky left-0 z-10 flex shrink-0 items-center gap-2 truncate border-r border-border bg-background px-3 text-left text-xs hover:bg-accent"
                    style={{ width: LABEL_WIDTH }}
                  >
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {clickUpTaskReference(bar.task)}
                    </span>
                    <span className="truncate text-foreground">{bar.task.name}</span>
                  </button>
                  <div className="relative" style={{ width: timelineWidth }}>
                    <button
                      type="button"
                      title={barTitle(bar)}
                      aria-label={barTitle(bar)}
                      onClick={() => onOpenTask(bar.task)}
                      className={cn(
                        'absolute top-1.5 h-4 rounded-sm opacity-90 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring',
                        bar.milestone && 'rotate-45 rounded-[2px]'
                      )}
                      style={{
                        left: bar.startDay * dayWidth + (bar.milestone ? dayWidth / 2 - 8 : 0),
                        width: bar.milestone ? 16 : Math.max(dayWidth, bar.spanDays * dayWidth - 2),
                        backgroundColor: bar.task.status.color
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ))}
          {layout.unscheduled.length > 0 ? (
            <div>
              <div className="h-7 border-b border-border bg-muted/50">
                <div className="sticky left-0 flex h-full w-fit items-center gap-2 px-3 text-xs font-medium text-foreground">
                  {translate('auto.components.clickup.gantt.unscheduled', 'Unscheduled')}
                  <span className="text-muted-foreground">{layout.unscheduled.length}</span>
                </div>
              </div>
              {layout.unscheduled.map((task) => (
                <div
                  key={task.id}
                  className="border-b border-border/60"
                  style={{ height: ROW_HEIGHT }}
                >
                  <button
                    type="button"
                    onClick={() => onOpenTask(task)}
                    className="sticky left-0 flex h-full items-center gap-2 px-3 text-left text-xs hover:bg-accent"
                    style={{ width: LABEL_WIDTH * 2 }}
                  >
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {clickUpTaskReference(task)}
                    </span>
                    <span className="truncate text-foreground">{task.name}</span>
                    <span className="shrink-0 text-muted-foreground">{task.status.name}</span>
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
