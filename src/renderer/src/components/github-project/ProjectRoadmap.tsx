import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CalendarClock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { i18n, translate } from '@/i18n/i18n'
import ProjectGroupHeader from './ProjectGroupHeader'
import ProjectRoadmapBar from './ProjectRoadmapBar'
import { ProjectTitleCell } from './ProjectCellIdentity'
import { formatRoadmapTick } from './roadmap-tick-format'
import { loadRoadmapZoom, saveRoadmapZoom } from './roadmap-zoom-preference'
import { groupRows, sortRows } from '../../../../shared/github/project-group-sort'
import {
  buildRoadmapTicks,
  getRoadmapSpan,
  resolveRoadmapDateSource,
  roadmapOffsetPx,
  roadmapSourceFieldNames,
  type RoadmapSpan,
  type RoadmapTick,
  type RoadmapZoom
} from '../../../../shared/github/project-roadmap-timeline'
import type { GitHubProjectRow, GitHubProjectTable } from '../../../../shared/github/project-types'

const LABEL_WIDTH_PX = 280
const LANE_HEIGHT_PX = 36
const TICK_WIDTH_PX: Record<RoadmapZoom, number> = { month: 148, quarter: 128, year: 160 }
const ZOOMS: RoadmapZoom[] = ['month', 'quarter', 'year']

function localTodayAsUtcMidnightMs(): number {
  const now = new Date()
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
}

type Props = {
  table: GitHubProjectTable
  onOpenDialog?: (row: GitHubProjectRow) => void
  /** Rendered instead of the timeline when the view has no field to place
   *  items on — the caller supplies the table list so the items stay usable. */
  fallback: React.ReactNode
}

export default function ProjectRoadmap({
  table,
  onOpenDialog,
  fallback
}: Props): React.JSX.Element {
  const view = table.selectedView
  const locale = i18n.resolvedLanguage ?? i18n.language
  // Why: the grid lives on UTC calendar days (parseRoadmapDate), so "today"
  // must be the viewer's LOCAL calendar date mapped to UTC midnight — the raw
  // instant would shift the marker into the wrong day off UTC.
  const [todayMs, setTodayMs] = useState(localTodayAsUtcMidnightMs)
  // Why: a pane left open across midnight would otherwise keep yesterday's
  // marker; re-arm after each fire so multi-day sessions stay honest.
  useEffect(() => {
    const now = new Date()
    const nextLocalMidnight = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1
    ).getTime()
    // Why: the +1s pad absorbs timer drift so the callback lands after the
    // date change, not just before it.
    const timer = setTimeout(
      () => setTodayMs(localTodayAsUtcMidnightMs()),
      nextLocalMidnight - now.getTime() + 1000
    )
    return () => clearTimeout(timer)
  }, [todayMs])
  const [zoom, setZoom] = useState<RoadmapZoom>(loadRoadmapZoom)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const source = useMemo(() => resolveRoadmapDateSource(view, table.rows), [view, table.rows])
  const groups = useMemo(() => groupRows(table, sortRows(table, table.rows)), [table])
  const spans = useMemo(() => {
    const bySpan = new Map<string, RoadmapSpan>()
    if (!source) {
      return bySpan
    }
    for (const row of table.rows) {
      const span = getRoadmapSpan(row, source)
      if (span) {
        bySpan.set(row.id, span)
      }
    }
    return bySpan
  }, [source, table.rows])

  const tickWidth = TICK_WIDTH_PX[zoom]
  const ticks = useMemo(
    () => buildRoadmapTicks(Array.from(spans.values()), zoom, todayMs),
    [spans, todayMs, zoom]
  )
  const timelineWidth = ticks.length * tickWidth
  const todayPx = roadmapOffsetPx(todayMs, ticks, tickWidth)

  // Why: the interesting part of a roadmap is around now — open there instead
  // of at the padded left edge, and re-centre when the zoom changes scale.
  const scrollToToday = useCallback(() => {
    const scroller = scrollRef.current
    if (!scroller) {
      return
    }
    const lead = (scroller.clientWidth - LABEL_WIDTH_PX) / 3
    scroller.scrollTo({ left: Math.max(0, todayPx - lead), behavior: 'smooth' })
  }, [todayPx])
  const todayPxRef = useRef(todayPx)
  useLayoutEffect(() => {
    todayPxRef.current = todayPx
  })
  // Why: position on mount and re-centre on zoom rescale ONLY — keying this on
  // todayPx would yank the user's scroll back to today whenever a background
  // refetch prepends grid columns and shifts the left edge.
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) {
      return
    }
    const lead = (scroller.clientWidth - LABEL_WIDTH_PX) / 3
    scroller.scrollLeft = Math.max(0, todayPxRef.current - lead)
  }, [zoom])

  const colorFieldId = useMemo(() => {
    const grouped = view.groupByFields.find((field) => field.kind === 'single-select')
    return (grouped ?? view.fields.find((field) => field.kind === 'single-select'))?.id ?? null
  }, [view])

  if (!source) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex-none border-b border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {translate(
            'auto.components.github.project.ProjectRoadmap.be52f7b6db',
            'This roadmap view has no date or iteration field to place items on, so Orca is listing them instead.'
          )}
        </div>
        {fallback}
      </div>
    )
  }

  if (table.rows.length === 0) {
    return (
      <div className="flex min-h-[120px] items-center justify-center p-6 text-sm text-muted-foreground">
        {translate(
          'auto.components.github.project.ProjectViewList.4f57d2e0b1',
          "No items match this view's filter."
        )}
      </div>
    )
  }

  const undatedCount = table.rows.length - spans.size
  const bandWidth = LABEL_WIDTH_PX + timelineWidth
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <RoadmapControls
        placedBy={roadmapSourceFieldNames(source).join(' → ')}
        undatedCount={undatedCount}
        zoom={zoom}
        onZoom={(next) => {
          setZoom(next)
          saveRoadmapZoom(next)
        }}
        onToday={scrollToToday}
      />
      <div
        ref={scrollRef}
        className="min-h-0 min-w-0 flex-1 overflow-auto scrollbar-sleek"
        data-testid="project-roadmap-scroller"
      >
        <div className="relative w-max min-w-full">
          <RoadmapHeaderRow
            ticks={ticks}
            tickWidth={tickWidth}
            zoom={zoom}
            locale={locale}
            todayPx={todayPx}
          />
          <div className="relative">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0"
              style={{
                left: LABEL_WIDTH_PX,
                backgroundImage: 'linear-gradient(to right, var(--border) 0 1px, transparent 1px)',
                backgroundSize: `${tickWidth}px 100%`
              }}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-foreground/30"
              style={{ left: LABEL_WIDTH_PX + todayPx }}
            />
            {groups.map((group) => {
              const expanded = !collapsed.has(group.key)
              return (
                <div key={group.key}>
                  {view.groupByFields[0] ? (
                    <ProjectGroupHeader
                      group={group}
                      expanded={expanded}
                      bandWidth={bandWidth}
                      onToggle={() =>
                        setCollapsed((previous) => {
                          const next = new Set(previous)
                          if (!next.delete(group.key)) {
                            next.add(group.key)
                          }
                          return next
                        })
                      }
                    />
                  ) : null}
                  {expanded
                    ? group.rows.map((row) => (
                        <RoadmapLane
                          key={row.id}
                          row={row}
                          span={spans.get(row.id) ?? null}
                          ticks={ticks}
                          tickWidth={tickWidth}
                          timelineWidth={timelineWidth}
                          colorFieldId={colorFieldId}
                          locale={locale}
                          onOpenDialog={onOpenDialog}
                        />
                      ))
                    : null}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function RoadmapControls({
  placedBy,
  undatedCount,
  zoom,
  onZoom,
  onToday
}: {
  placedBy: string
  undatedCount: number
  zoom: RoadmapZoom
  onZoom: (zoom: RoadmapZoom) => void
  onToday: () => void
}): React.JSX.Element {
  const zoomLabels: Record<RoadmapZoom, string> = {
    month: translate('auto.components.github.project.ProjectRoadmap.6405e036e0', 'Month'),
    quarter: translate('auto.components.github.project.ProjectRoadmap.f2b1cabef7', 'Quarter'),
    year: translate('auto.components.github.project.ProjectRoadmap.b6afc6fe45', 'Year')
  }
  return (
    <div className="flex min-w-0 flex-none flex-wrap items-center gap-2 border-b border-border/50 px-3 py-1.5 text-xs text-muted-foreground">
      <span className="truncate">
        {translate(
          'auto.components.github.project.ProjectRoadmap.343888b143',
          'Placed by {{value0}}',
          {
            value0: placedBy
          }
        )}
      </span>
      {undatedCount > 0 ? (
        <span className="rounded-full border border-border/50 px-1.5 text-[10px]">
          {translate(
            'auto.components.github.project.ProjectRoadmap.6a088a5da1',
            '{{value0}} without dates',
            { value0: undatedCount }
          )}
        </span>
      ) : null}
      <div className="ml-auto flex items-center gap-1">
        <Button type="button" size="xs" variant="outline" onClick={onToday}>
          <CalendarClock className="size-3" />
          {translate('auto.components.github.project.ProjectRoadmap.86eebd6020', 'Today')}
        </Button>
        <div
          role="group"
          aria-label={translate(
            'auto.components.github.project.ProjectRoadmap.0bb1c1bc07',
            'Timeline zoom'
          )}
          className="flex items-center rounded-md border border-border/60"
        >
          {ZOOMS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === zoom}
              onClick={() => onZoom(option)}
              className={cn(
                'px-2 py-0.5 text-[11px] first:rounded-l-md last:rounded-r-md',
                option === zoom ? 'bg-accent text-foreground' : 'hover:bg-accent/60'
              )}
            >
              {zoomLabels[option]}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function RoadmapHeaderRow({
  ticks,
  tickWidth,
  zoom,
  locale,
  todayPx
}: {
  ticks: RoadmapTick[]
  tickWidth: number
  zoom: RoadmapZoom
  locale: string
  todayPx: number
}): React.JSX.Element {
  return (
    <div className="sticky top-0 z-20 flex border-b border-border/60 bg-background/95 backdrop-blur">
      <div
        className="sticky left-0 z-30 shrink-0 border-r border-border/50 bg-background/95 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
        style={{ width: LABEL_WIDTH_PX }}
      >
        {translate('auto.components.github.project.ProjectRoadmap.e304235879', 'Item')}
      </div>
      <div className="relative flex">
        {ticks.map((tick, index) => {
          const { label, sublabel } = formatRoadmapTick(tick, zoom, index, locale)
          return (
            <div
              key={tick.key}
              className="shrink-0 border-l border-border/40 px-2 py-2 text-[11px] text-muted-foreground"
              style={{ width: tickWidth }}
            >
              <span className="font-medium text-foreground/80">{label}</span>
              {sublabel ? <span className="ml-1 opacity-70">{sublabel}</span> : null}
            </div>
          )
        })}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-px bg-foreground/30"
          style={{ left: todayPx }}
        />
      </div>
    </div>
  )
}

function RoadmapLane({
  row,
  span,
  ticks,
  tickWidth,
  timelineWidth,
  colorFieldId,
  locale,
  onOpenDialog
}: {
  row: GitHubProjectRow
  span: RoadmapSpan | null
  ticks: RoadmapTick[]
  tickWidth: number
  timelineWidth: number
  colorFieldId: string | null
  locale: string
  onOpenDialog?: (row: GitHubProjectRow) => void
}): React.JSX.Element {
  const statusValue = colorFieldId ? row.fieldValuesByFieldId[colorFieldId] : undefined
  const chipColor = statusValue?.kind === 'single-select' ? statusValue.color : null
  const left = span ? roadmapOffsetPx(span.startMs, ticks, tickWidth) : 0
  const width = span ? roadmapOffsetPx(span.endMs, ticks, tickWidth) - left : 0
  return (
    <div
      className="group flex items-stretch border-b border-border/30 hover:bg-accent/40"
      style={{ minHeight: LANE_HEIGHT_PX }}
    >
      <div
        className={cn(
          'sticky left-0 z-10 flex shrink-0 items-center gap-2 overflow-hidden border-r border-border/40 px-3',
          '[background:color-mix(in_srgb,var(--background)_95%,var(--muted))]',
          'group-hover:[background:color-mix(in_srgb,var(--accent)_60%,var(--background))]'
        )}
        style={{ width: LABEL_WIDTH_PX }}
      >
        <ProjectTitleCell row={row} onOpenDialog={() => onOpenDialog?.(row)} />
        {span ? null : (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {translate('auto.components.github.project.ProjectRoadmap.e077c79083', 'No dates')}
          </span>
        )}
      </div>
      <div className="relative shrink-0" style={{ width: timelineWidth }}>
        {span ? (
          <ProjectRoadmapBar
            row={row}
            span={span}
            leftPx={left}
            widthPx={width}
            chipColor={chipColor}
            locale={locale}
            onOpen={() => onOpenDialog?.(row)}
          />
        ) : null}
      </div>
    </div>
  )
}
