// Why: Bug 2 from the Phase 1b verification pass — SUB_ISSUES_PROGRESS
// renders a fixed-width progress bar *and* a "completed/total" counter
// (see ProjectCell.tsx). At the generic MIN_COLUMN_WIDTH (60px) floor, the
// bar alone consumed nearly the whole column and the counter was clipped
// to 0 visible pixels by the cell's `overflow: hidden` — confirmed live via
// DOM geometry (text span's left edge sat past the cell's right edge) in a
// real Orca build against real GitHub Project data. ProjectCell.test.tsx
// renders the cell in isolation with no column-width context, so it never
// caught this; this test locks the specific numeric floor instead, against
// buildProjectGridTemplate — the function the table actually renders with
// (not a parallel copy that could silently drift out of sync).
import { describe, expect, it } from 'vitest'
import type { GitHubProjectField } from '../../../../shared/github-project-types'
import {
  buildProjectGridTemplate,
  MIN_COLUMN_WIDTH,
  minColumnWidthFor,
  resolveWidth
} from './column-widths'

function field(dataType: string): GitHubProjectField {
  return { kind: 'field', id: dataType, name: dataType, dataType }
}

describe('minColumnWidthFor', () => {
  it('gives SUB_ISSUES_PROGRESS more room than the generic floor', () => {
    expect(minColumnWidthFor(field('SUB_ISSUES_PROGRESS'))).toBeGreaterThan(MIN_COLUMN_WIDTH)
  })

  it('falls back to the generic floor for fields with no special-case width', () => {
    expect(minColumnWidthFor(field('TEXT'))).toBe(MIN_COLUMN_WIDTH)
    expect(minColumnWidthFor(field('TRACKS'))).toBe(MIN_COLUMN_WIDTH)
  })
})

describe('resolveWidth', () => {
  it('rejects a stored fr weight below the field-specific floor', () => {
    const f = field('SUB_ISSUES_PROGRESS')
    // A stored weight that clears the generic 60px floor but not the
    // SUB_ISSUES_PROGRESS-specific 96px floor must not be honored verbatim —
    // resolveWidth's floor check must use minColumnWidthFor, not the flat
    // MIN_COLUMN_WIDTH constant.
    const width = resolveWidth(f, { [f.id]: 70 })
    expect(width).toBeGreaterThanOrEqual(minColumnWidthFor(f))
  })
})

describe('buildProjectGridTemplate', () => {
  it('emits a wider minmax floor for SUB_ISSUES_PROGRESS than other non-frozen fields', () => {
    // Index 0-1 are frozen (flat px, no minmax) — put the two test fields
    // at index 2+ so both hit the minmax branch this bug lived in.
    const fields = [field('TITLE'), field('TYPE'), field('TEXT'), field('SUB_ISSUES_PROGRESS')]
    const template = buildProjectGridTemplate(fields, {})
    const floor = minColumnWidthFor(field('SUB_ISSUES_PROGRESS'))
    expect(template).toContain(`minmax(${floor}px,`)
    expect(template).toContain(`minmax(${MIN_COLUMN_WIDTH}px,`)
  })
})
