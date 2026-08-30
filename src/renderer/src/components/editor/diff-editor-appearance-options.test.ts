import { describe, expect, it } from 'vitest'
import { buildDiffEditorAppearanceOptions } from './diff-editor-appearance-options'

describe('buildDiffEditorAppearanceOptions', () => {
  it('returns the shared diff chrome and density', () => {
    expect(buildDiffEditorAppearanceOptions(12)).toEqual({
      lineHeight: 21,
      guides: { indentation: false },
      renderLineHighlight: 'none',
      glyphMargin: false,
      lineDecorationsWidth: 26,
      lineNumbersMinChars: 5
    })
  })

  it('scales line height with font size and keeps it an integer', () => {
    expect(buildDiffEditorAppearanceOptions(14).lineHeight).toBe(25)
    expect(buildDiffEditorAppearanceOptions(16).lineHeight).toBe(28)
    expect(buildDiffEditorAppearanceOptions(9).lineHeight).toBe(16)
  })
})
