import type { ClaudeUsageHourlyPoint } from '../../../../shared/claude-usage-types'

export type ClaudeUsageTrendsMode = 'time' | 'day'
export type ClaudeUsageTrendsWindow = '1d' | '7d' | '30d' | '6m'

export const TRENDS_WINDOW_DAYS: Record<ClaudeUsageTrendsWindow, number> = {
  '1d': 1,
  '7d': 7,
  '30d': 30,
  '6m': 180
}

// Why: with 30+ overlaid day-lines, per-line opacity must drop so overlap
// density reads as darkness where usage repeats daily (ported from UsageScope).
export const TIME_TRENDS_LINE_OPACITY: Record<ClaudeUsageTrendsWindow, number> = {
  '1d': 0.9,
  '7d': 0.38,
  '30d': 0.2,
  '6m': 0.08
}

export function pointTotalTokens(point: ClaudeUsageHourlyPoint): number {
  return point.inputTokens + point.outputTokens + point.cacheReadTokens + point.cacheWriteTokens
}

function formatLocalDayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function listRecentLocalDays(days: number, reference: Date = new Date()): string[] {
  const anchor = new Date(reference)
  anchor.setHours(12, 0, 0, 0)
  const result: string[] = []
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(anchor)
    date.setDate(anchor.getDate() - offset)
    result.push(formatLocalDayKey(date))
  }
  return result
}

export type ClaudeUsageHourOfDayModel = {
  /** Local day keys, oldest → today (today is always the last index). */
  dayKeys: string[]
  /** columns[dayIndex][hour 0-23] = total tokens in that local hour bucket. */
  columns: number[][]
  maxTokens: number
}

export function buildHourOfDayModel(
  points: ClaudeUsageHourlyPoint[],
  days: number,
  reference: Date = new Date()
): ClaudeUsageHourOfDayModel {
  const dayKeys = listRecentLocalDays(days, reference)
  const indexByDay = new Map(dayKeys.map((day, index) => [day, index]))
  const columns = dayKeys.map(() => Array.from({ length: 24 }, () => 0))
  let maxTokens = 0

  for (const point of points) {
    const dayIndex = indexByDay.get(point.day)
    if (dayIndex === undefined || point.hour < 0 || point.hour > 23) {
      continue
    }
    const total = columns[dayIndex][point.hour] + pointTotalTokens(point)
    columns[dayIndex][point.hour] = total
    if (total > maxTokens) {
      maxTokens = total
    }
  }

  return { dayKeys, columns, maxTokens }
}

export type ClaudeUsageTrendsBucket = {
  /** 'YYYY-MM-DD' for day buckets, 'YYYY-MM' for month buckets. */
  key: string
  turnCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
}

export type ClaudeUsageDayTrend = {
  kind: 'day' | 'month'
  buckets: ClaudeUsageTrendsBucket[]
  maxTotalTokens: number
  windowTotalTokens: number
}

function createEmptyBucket(key: string): ClaudeUsageTrendsBucket {
  return {
    key,
    turnCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0
  }
}

function listRecentLocalMonths(days: number, reference: Date): string[] {
  const anchor = new Date(reference)
  anchor.setHours(12, 0, 0, 0)
  const start = new Date(anchor)
  start.setDate(anchor.getDate() - (days - 1))
  const months: string[] = []
  // Why: a window that starts mid-month would render its oldest month as an
  // artificially tiny bar; drop that partial month so month totals compare
  // honestly (the current month-to-date bar is conventional and kept).
  const firstFullMonthOffset = start.getDate() === 1 ? 0 : 1
  const cursor = new Date(start.getFullYear(), start.getMonth() + firstFullMonthOffset, 15, 12)
  while (
    cursor.getFullYear() < anchor.getFullYear() ||
    (cursor.getFullYear() === anchor.getFullYear() && cursor.getMonth() <= anchor.getMonth())
  ) {
    months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`)
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return months
}

export function buildDayTrend(
  points: ClaudeUsageHourlyPoint[],
  window: Exclude<ClaudeUsageTrendsWindow, '1d'>,
  reference: Date = new Date()
): ClaudeUsageDayTrend {
  const days = TRENDS_WINDOW_DAYS[window]
  // Why: 180 daily bars cannot fit a popover-width plot, so the 6M view
  // buckets by month like UsageScope's dashboard trend chart.
  const kind: 'day' | 'month' = window === '6m' ? 'month' : 'day'
  const keys =
    kind === 'month' ? listRecentLocalMonths(days, reference) : listRecentLocalDays(days, reference)
  const bucketByKey = new Map(keys.map((key) => [key, createEmptyBucket(key)]))
  const earliestDay = listRecentLocalDays(days, reference)[0]

  for (const point of points) {
    if (point.day < earliestDay) {
      continue
    }
    const bucket = bucketByKey.get(kind === 'month' ? point.day.slice(0, 7) : point.day)
    if (!bucket) {
      continue
    }
    bucket.turnCount += point.turnCount
    bucket.inputTokens += point.inputTokens
    bucket.outputTokens += point.outputTokens
    bucket.cacheReadTokens += point.cacheReadTokens
    bucket.cacheWriteTokens += point.cacheWriteTokens
    bucket.totalTokens += pointTotalTokens(point)
  }

  const buckets = keys.map((key) => bucketByKey.get(key)!)
  let maxTotalTokens = 0
  let windowTotalTokens = 0
  for (const bucket of buckets) {
    windowTotalTokens += bucket.totalTokens
    if (bucket.totalTokens > maxTotalTokens) {
      maxTotalTokens = bucket.totalTokens
    }
  }

  return { kind, buckets, maxTotalTokens, windowTotalTokens }
}

/**
 * Monotone-cubic (Fritsch–Carlson) SVG path through evenly indexed values,
 * matching d3's curveMonotoneX so day-lines never overshoot between hours.
 */
export function buildMonotoneLinePath(
  values: number[],
  toX: (index: number) => number,
  toY: (value: number) => number
): string {
  const count = values.length
  if (count === 0) {
    return ''
  }
  if (count === 1) {
    return `M${toX(0)},${toY(values[0])}`
  }

  const slopes: number[] = []
  for (let i = 0; i < count - 1; i++) {
    slopes.push(values[i + 1] - values[i])
  }
  const tangents: number[] = [slopes[0]]
  for (let i = 1; i < count - 1; i++) {
    tangents.push(slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2)
  }
  tangents.push(slopes[count - 2])
  for (let i = 0; i < count - 1; i++) {
    if (slopes[i] === 0) {
      tangents[i] = 0
      tangents[i + 1] = 0
      continue
    }
    const alpha = tangents[i] / slopes[i]
    const beta = tangents[i + 1] / slopes[i]
    const norm = alpha * alpha + beta * beta
    if (norm > 9) {
      const scale = 3 / Math.sqrt(norm)
      tangents[i] = scale * alpha * slopes[i]
      tangents[i + 1] = scale * beta * slopes[i]
    }
  }

  const round = (value: number): number => Math.round(value * 100) / 100
  let path = `M${round(toX(0))},${round(toY(values[0]))}`
  for (let i = 0; i < count - 1; i++) {
    const x0 = toX(i)
    const x1 = toX(i + 1)
    const dx = (x1 - x0) / 3
    const c1y = toY(values[i] + tangents[i] / 3)
    const c2y = toY(values[i + 1] - tangents[i + 1] / 3)
    path += `C${round(x0 + dx)},${round(c1y)},${round(x1 - dx)},${round(c2y)},${round(x1)},${round(toY(values[i + 1]))}`
  }
  return path
}

export function getHourTooltipStats(
  model: ClaudeUsageHourOfDayModel,
  hour: number
): { today: number; average: number; peak: number } {
  const values = model.columns.map((column) => column[hour] ?? 0)
  const activeValues = values.filter((value) => value > 0)
  const today = values.at(-1) ?? 0
  const average =
    activeValues.length === 0
      ? 0
      : Math.round(activeValues.reduce((sum, value) => sum + value, 0) / activeValues.length)
  const peak = values.reduce((max, value) => Math.max(max, value), 0)
  return { today, average, peak }
}
