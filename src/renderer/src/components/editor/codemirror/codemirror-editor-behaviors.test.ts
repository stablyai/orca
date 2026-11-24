import { Text } from '@codemirror/state'
import { describe, expect, test } from 'vitest'
import { buildConflictLineClasses } from './codemirror-conflict-decorations'
import { LARGE_FILE_HIGHLIGHT_LIMIT, resolveCodeMirrorLanguage } from './codemirror-languages'
import { computeRevealSelectionRange } from './codemirror-view-state'

describe('computeRevealSelectionRange', () => {
  test('selects match span on 1-based line and column', () => {
    const doc = Text.of(['first line', 'const targetValue = 42', 'last line'])
    const line2Start = doc.line(2).from
    expect(computeRevealSelectionRange(doc, 2, 7, 11)).toEqual({
      anchor: line2Start + 6,
      head: line2Start + 17
    })
  })

  test('clamps out-of-range lines and match lengths past line end', () => {
    const doc = Text.of(['abc', 'defgh'])
    const line2Start = doc.line(2).from
    expect(computeRevealSelectionRange(doc, 99, 2, 50)).toEqual({
      anchor: line2Start + 1,
      head: line2Start + 5
    })
    expect(computeRevealSelectionRange(doc, 1, 1, 0)).toEqual({
      anchor: 0,
      head: 0
    })
  })
})

describe('buildConflictLineClasses', () => {
  test('maps 3-way conflict block markers and sections in line order', () => {
    const sample = [
      'before',
      '<<<<<<< HEAD',
      'const a = 1',
      '||||||| merged common ancestors',
      'const a = 0',
      '=======',
      'const a = 2',
      '>>>>>>> feature',
      'after'
    ].join('\n')

    expect(buildConflictLineClasses(sample)).toEqual([
      { line: 2, className: 'cm-orca-conflict-marker' },
      { line: 3, className: 'cm-orca-conflict-current' },
      { line: 4, className: 'cm-orca-conflict-marker' },
      { line: 5, className: 'cm-orca-conflict-base' },
      { line: 6, className: 'cm-orca-conflict-marker' },
      { line: 7, className: 'cm-orca-conflict-incoming' },
      { line: 8, className: 'cm-orca-conflict-marker' }
    ])
    expect(buildConflictLineClasses('plain clean file\nsecond line')).toEqual([])
  })
})

describe('resolveCodeMirrorLanguage', () => {
  test('skips grammar activation above the large-file limit', () => {
    expect(
      resolveCodeMirrorLanguage('typescript', 'huge.ts', LARGE_FILE_HIGHLIGHT_LIMIT + 1)
    ).toEqual([])
    expect(resolveCodeMirrorLanguage('', 'types.pyi', 120)).not.toEqual([])
    expect(resolveCodeMirrorLanguage('', 'config.json5', 120)).not.toEqual([])
    expect(resolveCodeMirrorLanguage('', 'icon.svg', 120)).not.toEqual([])
    expect(resolveCodeMirrorLanguage('', 'Button.tsx', 120)).not.toEqual([])
  })
})
