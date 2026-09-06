import { describe, expect, it } from 'vitest'
import {
  findOrcaDispatchTaskMarkerIndex,
  ORCA_DISPATCH_STATUS_TASK_MARKER
} from './orca-dispatch-status-prompt'

describe('findOrcaDispatchTaskMarkerIndex', () => {
  it('anchors on the standalone line in raw multi-line preambles', () => {
    const prompt = [
      'You are working inside Orca, a multi-agent IDE.',
      '  - docs: explain === TASK === marker parsing',
      '',
      '=== TASK ===',
      'Real body'
    ].join('\n')
    const index = findOrcaDispatchTaskMarkerIndex(prompt)
    // Resolves the standalone-line marker, not the inline base-drift decoy.
    expect(index).toBe(prompt.lastIndexOf(ORCA_DISPATCH_STATUS_TASK_MARKER))
    expect(prompt.slice(index).startsWith(`${ORCA_DISPATCH_STATUS_TASK_MARKER}\nReal body`)).toBe(
      true
    )
  })

  it('anchors on whitespace for normalized single-line previews', () => {
    const prompt =
      'You are working inside Orca, a multi-agent IDE. Your task ID is: task_x === TASK === Compact body'
    const index = findOrcaDispatchTaskMarkerIndex(prompt)
    expect(index).toBe(prompt.indexOf(ORCA_DISPATCH_STATUS_TASK_MARKER))
  })

  it('skips a mid-token decoy before the real single-line marker', () => {
    // The first occurrence is glued to surrounding characters (not whitespace
    // anchored); the real marker later in the line is the one to return.
    const prompt =
      'You are working inside Orca, a multi-agent IDE. path/a=== TASK ===/b === TASK === Real body'
    const index = findOrcaDispatchTaskMarkerIndex(prompt)
    expect(index).toBe(prompt.lastIndexOf(ORCA_DISPATCH_STATUS_TASK_MARKER))
    expect(prompt.slice(index)).toBe(`${ORCA_DISPATCH_STATUS_TASK_MARKER} Real body`)
  })

  it('returns -1 when a single-line marker is only ever embedded mid-token', () => {
    const prompt = 'You are working inside Orca, a multi-agent IDE. x=== TASK ===y'
    expect(findOrcaDispatchTaskMarkerIndex(prompt)).toBe(-1)
  })

  it('returns -1 when a multi-line preamble has no standalone marker', () => {
    const prompt = 'You are working inside Orca.\n  note: === TASK === inline only\nmore'
    expect(findOrcaDispatchTaskMarkerIndex(prompt)).toBe(-1)
  })
})
