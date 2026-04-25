import { describe, expect, it } from 'vitest'
import { buildDiffEditorLineNumberOptions } from './diff-editor-line-number-options'

describe('buildDiffEditorLineNumberOptions', () => {
  it('hides original line numbers in inline mode', () => {
    expect(buildDiffEditorLineNumberOptions(false)).toEqual({
      original: 'off',
      modified: 'on'
    })
  })

  it('shows both gutters in side-by-side mode', () => {
    expect(buildDiffEditorLineNumberOptions(true)).toEqual({
      original: 'on',
      modified: 'on'
    })
  })
})
