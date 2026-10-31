import { describe, expect, it } from 'vitest'
import { resolveEditorTypography, type EditorTypographyInputs } from './editor-typography'

const terminal = { terminalFontFamily: 'JetBrains Mono', terminalFontSize: 14 }

describe('resolveEditorTypography', () => {
  it('keeps pre-setting rendering when no editor key is set', () => {
    expect(resolveEditorTypography(terminal, 0)).toMatchObject({
      fontFamily: 'JetBrains Mono',
      fontSize: 14,
      fontWeight: 'normal',
      lineHeight: 0,
      fontLigatures: false
    })
  })

  it('applies editor overrides independently of the terminal', () => {
    const typography = resolveEditorTypography(
      {
        ...terminal,
        editorFontSize: 16,
        editorFontWeight: 550,
        editorLineHeight: 1.6,
        editorLigatures: 'auto'
      },
      2
    )
    expect(typography).toMatchObject({
      fontSize: 18,
      fontWeight: '550',
      lineHeight: 29,
      fontLigatures: true
    })
  })

  it('derives diff size and line height from the editor base size', () => {
    const typography = resolveEditorTypography(
      { ...terminal, editorFontSize: 16, editorLineHeight: 2 },
      0,
      'diff'
    )
    expect(typography.fontSize).toBe(15.5)
    expect(typography.lineHeight).toBe(31)
  })

  it('reads line heights of 8 or more as pixels so they do not clamp to 3x', () => {
    const typography = resolveEditorTypography({ ...terminal, editorLineHeight: 21 }, 0)
    expect(typography.lineHeight).toBe(21)
  })

  it('ignores hand-edited values that are not usable', () => {
    // Settings files are untyped JSON on disk, so corrupt values arrive through JSON.parse.
    const handEdited: EditorTypographyInputs = JSON.parse(
      JSON.stringify({
        ...terminal,
        editorFontSize: 'big',
        editorFontWeight: null,
        editorLineHeight: -1,
        editorLigatures: 'yes'
      })
    )
    const typography = resolveEditorTypography(handEdited, 0)
    expect(typography).toMatchObject({
      fontSize: 14,
      fontWeight: 'normal',
      lineHeight: 0,
      fontLigatures: false
    })
  })
})
