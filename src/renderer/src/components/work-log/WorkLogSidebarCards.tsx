import type React from 'react'
import { CalendarClock, ExternalLink, RefreshCcw, Workflow } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { WorkLogProvider } from '../../../../shared/work-log-types'
import {
  DAY_LABEL_FORMATTER,
  WORK_LOG_PROVIDER_OPTIONS,
  formatDuration,
  parseLocalDateKey
} from './work-log-page-data'

export function WorkLogHeaderCard({
  selectedDate,
  todayHours,
  dayEntryCount
}: {
  selectedDate: string
  todayHours: string
  dayEntryCount: number
}): React.JSX.Element {
  return (
    <Card className="border-border/60 bg-card/95 shadow-sm">
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-xl">Work Log</CardTitle>
            <CardDescription>
              Capture badge-derived hours, link the work to a surface, and carry the week
              forward without leaving Orca.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="gap-1.5">
              <CalendarClock className="size-3.5" />
              {DAY_LABEL_FORMATTER.format(parseLocalDateKey(selectedDate))}
            </Badge>
            <Badge variant="secondary" className="gap-1.5">
              <Workflow className="size-3.5" />
              {todayHours}
            </Badge>
            <Badge variant="outline" className="gap-1.5">
              {dayEntryCount} blocks
            </Badge>
          </div>
        </div>
      </CardHeader>
    </Card>
  )
}

export function WorkLogSourceLanesCard({
  provider,
  onSelect
}: {
  provider: WorkLogProvider
  onSelect: (provider: WorkLogProvider) => void
}): React.JSX.Element {
  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Source lanes</CardTitle>
        <CardDescription>
          Keep the daily log grounded in the same provider labels the rest of Orca uses.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {WORK_LOG_PROVIDER_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onSelect(option.value)}
            className={cn(
              'flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
              provider === option.value
                ? 'border-primary/40 bg-primary/5 text-foreground'
                : 'border-border/60 bg-muted/20 text-muted-foreground hover:bg-muted/35 hover:text-foreground'
            )}
          >
            <div className="space-y-0.5">
              <div className="text-sm font-medium">{option.label}</div>
              <div className="text-xs">{option.description}</div>
            </div>
            <Badge variant={provider === option.value ? 'secondary' : 'outline'}>
              {option.value}
            </Badge>
          </button>
        ))}
      </CardContent>
    </Card>
  )
}

export function WorkLogWeeklySummaryCard({
  weekHours,
  weekEntryCount,
  focusHours,
  weekDayMinutes,
  maxWeekMinutes
}: {
  weekHours: string
  weekEntryCount: number
  focusHours: string
  weekDayMinutes: { dayKey: string; minutes: number }[]
  maxWeekMinutes: number
}): React.JSX.Element {
  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Weekly summary</CardTitle>
        <CardDescription>A rolling seven-day readout for the selected day.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <SummaryBox
            label="Total"
            value={weekHours}
            description={`${weekEntryCount} blocks across seven days`}
          />
          <SummaryBox
            label="Focus"
            value={focusHours}
            description="Badge-derived estimate from the active workspace."
          />
        </div>
        <Separator />
        <div className="space-y-2">
          {weekDayMinutes.map((day) => (
            <div key={day.dayKey} className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">
                  {DAY_LABEL_FORMATTER.format(parseLocalDateKey(day.dayKey))}
                </span>
                <span className="text-muted-foreground">{formatDuration(day.minutes)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary/70"
                  style={{ width: `${(day.minutes / maxWeekMinutes) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export function WorkLogCurrentSurfaceCard({
  taskSurfaceAvailable,
  currentTaskLabel,
  currentTaskMeta,
  onReopenTask,
  onJumpToToday
}: {
  taskSurfaceAvailable: boolean
  currentTaskLabel: string
  currentTaskMeta: string
  onReopenTask: () => void
  onJumpToToday: () => void
}): React.JSX.Element {
  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Current surface</CardTitle>
        <CardDescription>
          Reopen the task detail that was active before you switched to the log.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {taskSurfaceAvailable ? (
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
            <div className="text-sm font-medium">{currentTaskLabel}</div>
            <div className="mt-1 text-xs text-muted-foreground">{currentTaskMeta}</div>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 p-3 text-sm text-muted-foreground">
            Open a task first if you want the log tied to a specific work item.
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={onReopenTask} disabled={!taskSurfaceAvailable}>
            <ExternalLink className="size-4" />
            Reopen task detail
          </Button>
          <Button type="button" variant="ghost" onClick={onJumpToToday}>
            <RefreshCcw className="size-4" />
            Jump to today
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function SummaryBox({
  label,
  value,
  description
}: {
  label: string
  value: string
  description: string
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/25 p-3">
      <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{description}</div>
    </div>
  )
}
