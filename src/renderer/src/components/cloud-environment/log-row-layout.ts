import type { BuildLogBuffer, LogLine } from './build-log-model'
import type { BuildStepView } from './build-steps'
import type { EnvironmentBuildStep, EnvironmentBuildView } from './cloud-environment-types'

/** One virtualized row: a step header, a log line, or a step's placeholder when it has none. */
export type Row =
  | { kind: 'header'; step: BuildStepView; lineCount: number }
  | { kind: 'line'; line: LogLine; number: number }
  | { kind: 'empty'; step: EnvironmentBuildStep }

/** A step's slice of the flattened row list. */
export type Segment = {
  step: BuildStepView
  firstRow: number
  rowCount: number
  lineStart: number
  lineCount: number
  expanded: boolean
}

export function defaultExpanded(
  step: BuildStepView,
  focus: EnvironmentBuildStep | null,
  build: EnvironmentBuildView
): boolean {
  if (focus) {
    return step.id === focus
  }
  // A finished, successful build: the install script is what people come to read.
  return build.status === 'succeeded' && step.id === 'install'
}

function segmentAt(segments: readonly Segment[], index: number): Segment {
  let segment = segments[0]
  for (const candidate of segments) {
    if (candidate.firstRow > index) {
      break
    }
    segment = candidate
  }
  return segment
}

/** O(steps) lookup: rows are never materialised, so a 50k-line log costs nothing until shown. */
export function rowAtIndex(
  segments: readonly Segment[],
  buffer: BuildLogBuffer,
  index: number
): Row {
  const segment = segmentAt(segments, index)
  const offset = index - segment.firstRow
  if (offset === 0) {
    return {
      kind: 'header',
      step: segment.step,
      lineCount: buffer.outputLineCount(segment.step.id)
    }
  }
  if (segment.lineCount === 0) {
    return { kind: 'empty', step: segment.step.id }
  }
  return { kind: 'line', line: buffer.lines[segment.lineStart + offset - 1], number: offset }
}

/** Size estimate without building a Row (called for every row on each re-measure). */
export function rowSizeAt(
  segments: readonly Segment[],
  index: number,
  headerPx: number,
  linePx: number
): number {
  return index === segmentAt(segments, index).firstRow ? headerPx : linePx
}

/** Stable React key without building a Row: line ids survive appends and replays. */
export function rowKeyAt(
  segments: readonly Segment[],
  buffer: BuildLogBuffer,
  index: number
): string | number {
  const segment = segmentAt(segments, index)
  const offset = index - segment.firstRow
  if (offset === 0) {
    return `h:${segment.step.id}`
  }
  if (segment.lineCount === 0) {
    return `e:${segment.step.id}`
  }
  return buffer.lines[segment.lineStart + offset - 1]?.id ?? `x:${index}`
}

/**
 * Where a failed build should open: null when it needs no scroll (everything fits, or the failing
 * step is collapsed); else the row to align to the top: the step header when its error fits below
 * it, otherwise a few lines of context above Orca's error note (or the step's last line).
 */
export function failureScrollRow(
  segments: readonly Segment[],
  buffer: BuildLogBuffer,
  failedStep: EnvironmentBuildStep,
  viewport: { height: number; totalSize: number; headerPx: number; linePx: number }
): number | null {
  const segment = segments.find((entry) => entry.step.id === failedStep)
  if (!segment || !segment.expanded || viewport.totalSize <= viewport.height) {
    return null
  }
  let target = segment.firstRow + Math.max(segment.lineCount, 1)
  for (let i = 0; i < segment.lineCount; i += 1) {
    if (buffer.lines[segment.lineStart + i]?.kind === 'orca-error') {
      target = segment.firstRow + 1 + i
      break
    }
  }
  const visibleRows = Math.floor((viewport.height - viewport.headerPx) / viewport.linePx)
  return target - segment.firstRow < visibleRows
    ? segment.firstRow
    : Math.max(segment.firstRow, target - Math.floor(visibleRows / 2))
}

/** The largest row end at or below `cap` (rows are measured top-down); `cap` if none qualifies. */
export function lastRowBoundary(rows: readonly { end: number }[], cap: number): number {
  let best = 0
  for (const row of rows) {
    if (row.end > cap) {
      break
    }
    best = row.end
  }
  return best > 0 ? best : cap
}
