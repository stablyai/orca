import { describe, expect, it } from 'vitest'
import { BuildLogBuffer } from './build-log-model'
import type { BuildStepView } from './build-steps'
import {
  failureScrollRow,
  lastRowBoundary,
  rowKeyAt,
  rowSizeAt,
  type Segment
} from './log-row-layout'

function step(id: BuildStepView['id']): BuildStepView {
  return { id, status: 'succeeded', startedAt: null, endedAt: null, durationMs: null }
}

/** boot (header only), install (header + 30 lines, an Orca error at line 25). */
function failedLayout(expanded = true): { segments: Segment[]; buffer: BuildLogBuffer } {
  const buffer = new BuildLogBuffer((flush) => flush())
  buffer.append('stdout', '::orca-step:: install\n')
  for (let i = 0; i < 30; i += 1) {
    buffer.append('stdout', i === 24 ? '::orca-error:: boom\n' : `line ${i}\n`)
  }
  const segments: Segment[] = [
    { step: step('boot'), firstRow: 0, rowCount: 1, lineStart: 0, lineCount: 0, expanded: false },
    {
      step: { ...step('install'), status: 'failed' },
      firstRow: 1,
      rowCount: expanded ? 31 : 1,
      lineStart: 0,
      lineCount: 30,
      expanded
    }
  ]
  return { segments, buffer }
}

describe('lastRowBoundary', () => {
  it('stops at the last row that fits whole', () => {
    const rows = [{ end: 40 }, { end: 80 }, { end: 100 }, { end: 440 }, { end: 480 }]
    expect(lastRowBoundary(rows, 460)).toBe(440)
    expect(lastRowBoundary(rows, 480)).toBe(480)
  })

  it('falls back to the cap when nothing is measured', () => {
    expect(lastRowBoundary([], 460)).toBe(460)
  })
})

describe('row keys and sizes', () => {
  it('derives keys and sizes from segment arithmetic and line ids', () => {
    const { segments, buffer } = failedLayout()
    expect(rowKeyAt(segments, buffer, 0)).toBe('h:boot')
    expect(rowKeyAt(segments, buffer, 1)).toBe('h:install')
    expect(rowKeyAt(segments, buffer, 2)).toBe(buffer.lines[0].id)
    expect(rowSizeAt(segments, 1, 40, 20)).toBe(40)
    expect(rowSizeAt(segments, 5, 40, 20)).toBe(20)
  })
})

describe('failureScrollRow', () => {
  const viewport = { height: 200, totalSize: 1000, headerPx: 40, linePx: 20 }

  it('centres context above the Orca error when the step is longer than the viewport', () => {
    const { segments, buffer } = failedLayout()
    // error at row 1 + 1 + 24 = 26; 8 visible rows -> 4 rows of context above it.
    expect(failureScrollRow(segments, buffer, 'install', viewport)).toBe(22)
  })

  it('aligns the step header when its error fits below it', () => {
    const { segments, buffer } = failedLayout()
    expect(failureScrollRow(segments, buffer, 'install', { ...viewport, height: 800 })).toBe(1)
  })

  it('does not scroll when everything fits or the step is collapsed', () => {
    const { segments, buffer } = failedLayout()
    expect(
      failureScrollRow(segments, buffer, 'install', { ...viewport, totalSize: 150 })
    ).toBeNull()
    const collapsed = failedLayout(false)
    expect(failureScrollRow(collapsed.segments, collapsed.buffer, 'install', viewport)).toBeNull()
  })
})
