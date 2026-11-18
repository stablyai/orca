// GraphQL ProjectV2View omits roadmap date configuration; derive placement from fields here for consistent, testable desktop/mobile bars.
import type { GitHubProjectField, GitHubProjectRow, GitHubProjectView } from './project-types'

export const ROADMAP_DAY_MS = 86_400_000

export type RoadmapZoom = 'month' | 'quarter' | 'year'

export type RoadmapDateSource =
  | { kind: 'date-range'; startField: GitHubProjectField; targetField: GitHubProjectField }
  | { kind: 'date-point'; field: GitHubProjectField }
  | { kind: 'iteration'; field: GitHubProjectField }

export type RoadmapSpan = {
  startMs: number
  /** Exclusive — a single-day item ends one day after it starts. */
  endMs: number
  /** True when only one date was known, so the bar renders as a marker. */
  point: boolean
}

export type RoadmapTick = {
  key: string
  startMs: number
  /** Exclusive. */
  endMs: number
}

const START_FIELD_PATTERN = /start|kick.?off|begin/i
const TARGET_FIELD_PATTERN = /target|end|due|finish|complet|deadline|ship/i

const MONTHS_PER_UNIT: Record<RoadmapZoom, number> = { month: 1, quarter: 3, year: 12 }
const MIN_UNITS: Record<RoadmapZoom, number> = { month: 6, quarter: 4, year: 3 }
// Cap typo-driven date ranges to avoid huge grids; out-of-range bars clamp visibly instead of hanging.
const MAX_TICKS = 480

function isDateField(field: GitHubProjectField): boolean {
  return field.kind === 'field' && field.dataType === 'DATE'
}

function pickDateSource(
  dateFields: GitHubProjectField[],
  iterationField: GitHubProjectField | null
): RoadmapDateSource | null {
  const startField = dateFields.find((field) => START_FIELD_PATTERN.test(field.name))
  const targetField = dateFields.find(
    (field) => field.id !== startField?.id && TARGET_FIELD_PATTERN.test(field.name)
  )
  if (startField && targetField) {
    return { kind: 'date-range', startField, targetField }
  }
  // Keep a singly matched date field in its role; plain field order could invert start/target.
  if (startField) {
    const other = dateFields.find((field) => field.id !== startField.id)
    if (other) {
      return { kind: 'date-range', startField, targetField: other }
    }
  }
  if (targetField) {
    const other = dateFields.find((field) => field.id !== targetField.id)
    if (other) {
      return { kind: 'date-range', startField: other, targetField }
    }
  }
  const [first, second] = dateFields
  // Fallback to view field order for localized/unusual names instead of degrading ranges to markers.
  if (first && second) {
    return { kind: 'date-range', startField: first, targetField: second }
  }
  if (iterationField) {
    return { kind: 'iteration', field: iterationField }
  }
  if (first) {
    return { kind: 'date-point', field: first }
  }
  return null
}

export function resolveRoadmapDateSource(
  view: GitHubProjectView,
  rows: readonly GitHubProjectRow[] = []
): RoadmapDateSource | null {
  // Placement fields can be hidden; sort/group fields provide secondary configuration evidence.
  const seen = new Set<string>()
  const candidates: GitHubProjectField[] = []
  for (const field of [
    ...view.fields,
    ...view.sortByFields.map((sort) => sort.field),
    ...view.groupByFields
  ]) {
    if (!seen.has(field.id)) {
      seen.add(field.id)
      candidates.push(field)
    }
  }
  const fromConfig = pickDateSource(
    candidates.filter(isDateField),
    candidates.find((field) => field.kind === 'iteration') ?? null
  )
  // Row values may supply dates even when view configuration exposes no placement fields.
  return fromConfig ?? pickDateSource(...collectRowPlacementFields(rows))
}

function collectRowPlacementFields(
  rows: readonly GitHubProjectRow[]
): [GitHubProjectField[], GitHubProjectField | null] {
  const dateFieldsById = new Map<string, GitHubProjectField>()
  let iterationField: GitHubProjectField | null = null
  for (const row of rows) {
    for (const value of Object.values(row.fieldValuesByFieldId)) {
      if (value.kind === 'date' && !dateFieldsById.has(value.fieldId)) {
        dateFieldsById.set(value.fieldId, {
          kind: 'field',
          id: value.fieldId,
          name: value.fieldName ?? 'Date',
          dataType: 'DATE'
        })
      } else if (value.kind === 'iteration' && !iterationField) {
        iterationField = {
          kind: 'iteration',
          id: value.fieldId,
          name: value.fieldName ?? 'Iteration',
          dataType: 'ITERATION',
          iterations: []
        }
      }
    }
  }
  return [Array.from(dateFieldsById.values()), iterationField]
}

/** Read GitHub YYYY-MM-DD dates, tolerating the date portion of full ISO timestamps. */
export function parseRoadmapDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) {
    return null
  }
  const [, year, month, day] = match
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day))
  if (Number.isNaN(ms)) {
    return null
  }
  // Date.UTC normalizes overflow (Feb 30 → Mar 2); round-trip components to reject invalid dates.
  const roundTrip = new Date(ms)
  if (
    roundTrip.getUTCFullYear() !== Number(year) ||
    roundTrip.getUTCMonth() !== Number(month) - 1 ||
    roundTrip.getUTCDate() !== Number(day)
  ) {
    return null
  }
  return ms
}

function readDateValue(row: GitHubProjectRow, field: GitHubProjectField): number | null {
  const value = row.fieldValuesByFieldId[field.id]
  return value?.kind === 'date' ? parseRoadmapDate(value.date) : null
}

export function getRoadmapSpan(
  row: GitHubProjectRow,
  source: RoadmapDateSource
): RoadmapSpan | null {
  if (source.kind === 'iteration') {
    const value = row.fieldValuesByFieldId[source.field.id]
    if (value?.kind !== 'iteration') {
      return null
    }
    const startMs = parseRoadmapDate(value.startDate)
    if (startMs === null) {
      return null
    }
    const days = value.duration > 0 ? value.duration : 1
    return { startMs, endMs: startMs + days * ROADMAP_DAY_MS, point: false }
  }
  if (source.kind === 'date-point') {
    const ms = readDateValue(row, source.field)
    return ms === null ? null : { startMs: ms, endMs: ms + ROADMAP_DAY_MS, point: true }
  }
  const startValue = readDateValue(row, source.startField)
  const targetValue = readDateValue(row, source.targetField)
  if (startValue === null || targetValue === null) {
    const known = startValue ?? targetValue
    return known === null ? null : { startMs: known, endMs: known + ROADMAP_DAY_MS, point: true }
  }
  // Reversed dates are user data; order them so the item retains a bar.
  return {
    startMs: Math.min(startValue, targetValue),
    endMs: Math.max(startValue, targetValue) + ROADMAP_DAY_MS,
    point: false
  }
}

function unitIndexOf(ms: number, zoom: RoadmapZoom): number {
  const date = new Date(ms)
  return Math.floor((date.getUTCFullYear() * 12 + date.getUTCMonth()) / MONTHS_PER_UNIT[zoom])
}

function unitStart(index: number, zoom: RoadmapZoom): number {
  const months = index * MONTHS_PER_UNIT[zoom]
  return Date.UTC(Math.floor(months / 12), months % 12, 1)
}

/** Cover spans and today, with one unit of padding per side and a readable minimum width. */
export function buildRoadmapTicks(
  spans: readonly RoadmapSpan[],
  zoom: RoadmapZoom,
  todayMs: number
): RoadmapTick[] {
  let earliest = todayMs
  let latest = todayMs
  for (const span of spans) {
    earliest = Math.min(earliest, span.startMs)
    latest = Math.max(latest, span.endMs)
  }
  let firstIdx = unitIndexOf(earliest, zoom) - 1
  // Exclusive span ends on unit boundaries belong to the previous tick; subtract before computing trailing padding.
  let lastIdxExclusive = unitIndexOf(latest - 1, zoom) + 2
  if (lastIdxExclusive - firstIdx < MIN_UNITS[zoom]) {
    lastIdxExclusive = firstIdx + MIN_UNITS[zoom]
  }
  // Keep today within the capped grid; trim the farther side first so one typo cannot consume all columns.
  if (lastIdxExclusive - firstIdx > MAX_TICKS) {
    const todayIdx = unitIndexOf(todayMs, zoom)
    firstIdx = Math.max(firstIdx, todayIdx + 2 - MAX_TICKS)
    lastIdxExclusive = Math.min(lastIdxExclusive, firstIdx + MAX_TICKS)
  }
  const ticks: RoadmapTick[] = []
  for (let index = firstIdx; index < lastIdxExclusive; index++) {
    const startMs = unitStart(index, zoom)
    ticks.push({
      key: new Date(startMs).toISOString().slice(0, 10),
      startMs,
      endMs: unitStart(index + 1, zoom)
    })
  }
  return ticks
}

/** Interpolate inside each tick to align bar edges despite unequal month lengths. */
export function roadmapOffsetPx(
  ms: number,
  ticks: readonly RoadmapTick[],
  tickWidthPx: number
): number {
  const first = ticks[0]
  const last = ticks.at(-1)
  if (!first || !last) {
    return 0
  }
  if (ms <= first.startMs) {
    return 0
  }
  if (ms >= last.endMs) {
    return ticks.length * tickWidthPx
  }
  let low = 0
  let high = ticks.length - 1
  while (low < high) {
    const mid = (low + high) >> 1
    const tick = ticks[mid]
    if (tick && ms >= tick.endMs) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  const tick = ticks[low]
  if (!tick) {
    return 0
  }
  const ratio = (ms - tick.startMs) / (tick.endMs - tick.startMs)
  return (low + ratio) * tickWidthPx
}

export function roadmapSourceFieldNames(source: RoadmapDateSource): string[] {
  if (source.kind === 'date-range') {
    return [source.startField.name, source.targetField.name]
  }
  return [source.field.name]
}
