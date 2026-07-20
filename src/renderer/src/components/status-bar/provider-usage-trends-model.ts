export type UsageTrendsMode = 'time' | 'day'
export type UsageTrendsPreset = '1d' | '7d' | '30d' | '6m'
export type UsageTrendsWindow = UsageTrendsPreset | 'custom'

export type UsageHourlyPoint = {
  day: string
  hour: number
  eventCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningOutputTokens: number
  toolTokens: number
  totalTokens: number
}

export const TRENDS_WINDOW_DAYS: Record<UsageTrendsPreset, number> = {
  '1d': 1,
  '7d': 7,
  '30d': 30,
  '6m': 180
}

const MONTHLY_BUCKET_THRESHOLD_DAYS = 45

export function pointTotalTokens(point: UsageHourlyPoint): number {
  return point.totalTokens
}

export function formatLocalDayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dayKeyToLocalDate(dayKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  if (!match) {
    return null
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day, 12)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null
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

export function listLocalDaysInRange(startDay: string, endDay: string): string[] {
  const start = dayKeyToLocalDate(startDay)
  const end = dayKeyToLocalDate(endDay)
  if (!start || !end || start > end) {
    return []
  }
  const days: string[] = []
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    days.push(formatLocalDayKey(cursor))
  }
  return days
}

export function getTimeTrendsLineOpacity(dayCount: number): number {
  if (dayCount <= 1) {
    return 0.9
  }
  if (dayCount <= 7) {
    return 0.38
  }
  if (dayCount <= 30) {
    return 0.2
  }
  // Why: custom ranges can span years. Keep their overlaid paths legible
  // without turning a long local history into an opaque SVG block.
  return Math.max(0.02, Math.min(0.08, 14 / dayCount))
}

export type ProviderUsageHourOfDayModel = {
  /** Local day keys, oldest → selected range end. */
  dayKeys: string[]
  /** columns[dayIndex][hour 0-23] = total tokens in that local hour bucket. */
  columns: number[][]
  maxTokens: number
}

export function buildHourOfDayModel(
  points: UsageHourlyPoint[],
  dayKeys: string[]
): ProviderUsageHourOfDayModel {
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

export type UsageTrendsBucket = {
  /** 'YYYY-MM-DD' for day buckets, 'YYYY-MM' for month buckets. */
  key: string
  eventCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningOutputTokens: number
  toolTokens: number
  totalTokens: number
}

export type ProviderUsageDayTrend = {
  kind: 'day' | 'month'
  buckets: UsageTrendsBucket[]
  maxTotalTokens: number
  windowTotalTokens: number
}

function createEmptyBucket(key: string): UsageTrendsBucket {
  return {
    key,
    eventCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningOutputTokens: 0,
    toolTokens: 0,
    totalTokens: 0
  }
}

function listMonthsForDayRange(dayKeys: string[], trimPartialFirstMonth: boolean): string[] {
  const firstDate = dayKeyToLocalDate(dayKeys[0] ?? '')
  const lastDate = dayKeyToLocalDate(dayKeys.at(-1) ?? '')
  if (!firstDate || !lastDate) {
    return []
  }
  const cursor = new Date(firstDate.getFullYear(), firstDate.getMonth(), 15, 12)
  if (trimPartialFirstMonth && firstDate.getDate() !== 1) {
    cursor.setMonth(cursor.getMonth() + 1)
  }
  const months: string[] = []
  while (
    cursor.getFullYear() < lastDate.getFullYear() ||
    (cursor.getFullYear() === lastDate.getFullYear() && cursor.getMonth() <= lastDate.getMonth())
  ) {
    months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`)
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return months
}

export function buildDayTrend(
  points: UsageHourlyPoint[],
  dayKeys: string[],
  options: { trimPartialFirstMonth?: boolean } = {}
): ProviderUsageDayTrend {
  const kind: 'day' | 'month' = dayKeys.length > MONTHLY_BUCKET_THRESHOLD_DAYS ? 'month' : 'day'
  const keys =
    kind === 'month'
      ? listMonthsForDayRange(dayKeys, options.trimPartialFirstMonth ?? false)
      : dayKeys
  const bucketByKey = new Map(keys.map((key) => [key, createEmptyBucket(key)]))
  const selectedDays = new Set(dayKeys)

  for (const point of points) {
    if (!selectedDays.has(point.day)) {
      continue
    }
    const bucket = bucketByKey.get(kind === 'month' ? point.day.slice(0, 7) : point.day)
    if (!bucket) {
      continue
    }
    bucket.eventCount += point.eventCount
    bucket.inputTokens += point.inputTokens
    bucket.outputTokens += point.outputTokens
    bucket.cacheReadTokens += point.cacheReadTokens
    bucket.cacheWriteTokens += point.cacheWriteTokens
    bucket.reasoningOutputTokens += point.reasoningOutputTokens
    bucket.toolTokens += point.toolTokens
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
  model: ProviderUsageHourOfDayModel,
  hour: number
): { latest: number; average: number; peak: number } {
  const values = model.columns.map((column) => column[hour] ?? 0)
  const activeValues = values.filter((value) => value > 0)
  const latest = values.at(-1) ?? 0
  const average =
    activeValues.length === 0
      ? 0
      : Math.round(activeValues.reduce((sum, value) => sum + value, 0) / activeValues.length)
  const peak = values.reduce((max, value) => Math.max(max, value), 0)
  return { latest, average, peak }
}
