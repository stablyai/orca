import type { ClickUpTask } from '../../../shared/clickup-types'
import type { ClickUpGanttGroupBy, ClickUpGanttZoom } from './clickup-task-view-preferences'

const DAY_MS = 24 * 60 * 60 * 1000
// Pixel width of one day per zoom; week zoom fits a quarter on a laptop screen.
export const GANTT_DAY_WIDTH: Record<ClickUpGanttZoom, number> = { day: 36, week: 10 }
// Padding around the scheduled range so bars never touch the edges.
const RANGE_PADDING_DAYS = 3

export type GanttBar = {
  task: ClickUpTask
  // Day offsets from the range start; a milestone has span 1 at its due day.
  startDay: number
  spanDays: number
  milestone: boolean
}

export type GanttGroup = { key: string; label: string; color?: string; bars: GanttBar[] }

export type GanttLayout = {
  rangeStart: Date
  totalDays: number
  todayOffset: number | null
  groups: GanttGroup[]
  unscheduled: ClickUpTask[]
}

export function startOfLocalDay(value: Date | number | string): Date {
  const date = new Date(value)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function dayIndex(from: Date, to: Date): number {
  // Why round: DST shifts make a local day 23 or 25 hours long.
  return Math.round((startOfLocalDay(to).getTime() - from.getTime()) / DAY_MS)
}

type Scheduled = { task: ClickUpTask; start: Date; end: Date; milestone: boolean }

function schedule(task: ClickUpTask): Scheduled | null {
  const due = task.dueDate ? startOfLocalDay(task.dueDate) : null
  const start = task.startDate ? startOfLocalDay(task.startDate) : null
  if (start && due) {
    // A start after the due date is bad data; show it as a one-day bar at the start.
    return due >= start
      ? { task, start, end: due, milestone: false }
      : { task, start, end: start, milestone: false }
  }
  if (due) {
    return { task, start: due, end: due, milestone: true }
  }
  if (start) {
    return { task, start, end: start, milestone: false }
  }
  return null
}

function groupFor(
  task: ClickUpTask,
  groupBy: ClickUpGanttGroupBy
): { key: string; label: string; color?: string } {
  return groupBy === 'status'
    ? { key: `status:${task.status.name}`, label: task.status.name, color: task.status.color }
    : { key: `list:${task.list.id}`, label: task.list.name }
}

export function buildClickUpGanttLayout(
  tasks: readonly ClickUpTask[],
  groupBy: ClickUpGanttGroupBy,
  now: Date = new Date()
): GanttLayout {
  const scheduled: Scheduled[] = []
  const unscheduled: ClickUpTask[] = []
  for (const task of tasks) {
    const item = schedule(task)
    if (item) {
      scheduled.push(item)
    } else {
      unscheduled.push(task)
    }
  }
  const today = startOfLocalDay(now)
  const times = scheduled.flatMap((item) => [item.start.getTime(), item.end.getTime()])
  // Why include today: the marker is the anchor people scroll from.
  const min = Math.min(today.getTime(), ...times)
  const max = Math.max(today.getTime(), ...times)
  const rangeStart = new Date(startOfLocalDay(min).getTime() - RANGE_PADDING_DAYS * DAY_MS)
  const rangeStartDay = startOfLocalDay(rangeStart)
  const totalDays = dayIndex(rangeStartDay, new Date(max)) + 1 + RANGE_PADDING_DAYS

  const groups = new Map<string, GanttGroup>()
  for (const item of scheduled.sort((a, b) => a.start.getTime() - b.start.getTime())) {
    const group = groupFor(item.task, groupBy)
    const entry = groups.get(group.key) ?? { ...group, bars: [] }
    entry.bars.push({
      task: item.task,
      startDay: dayIndex(rangeStartDay, item.start),
      spanDays: dayIndex(item.start, item.end) + 1,
      milestone: item.milestone
    })
    groups.set(group.key, entry)
  }
  return {
    rangeStart: rangeStartDay,
    totalDays,
    todayOffset: dayIndex(rangeStartDay, today),
    groups: [...groups.values()].sort((a, b) => a.label.localeCompare(b.label)),
    unscheduled
  }
}

export type GanttTick = { offset: number; label: string; major: boolean }

// Axis labels: every day at day zoom (months marked major), Mondays at week zoom.
export function buildClickUpGanttTicks(
  rangeStart: Date,
  totalDays: number,
  zoom: ClickUpGanttZoom,
  locale?: string
): GanttTick[] {
  const ticks: GanttTick[] = []
  for (let offset = 0; offset < totalDays; offset += 1) {
    const date = new Date(
      rangeStart.getFullYear(),
      rangeStart.getMonth(),
      rangeStart.getDate() + offset
    )
    const major = date.getDate() === 1
    if (zoom === 'day') {
      ticks.push({
        offset,
        label: major
          ? date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
          : String(date.getDate()),
        major
      })
    } else if (date.getDay() === 1) {
      ticks.push({
        offset,
        label: date.toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
        major
      })
    }
  }
  return ticks
}
