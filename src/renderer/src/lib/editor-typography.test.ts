import { describe, expect, it } from 'vitest'
import { resolveEditorTypography } from './editor-typography'

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

  it('ignores hand-edited values that are not usable numbers', () => {
    const typography = resolveEditorTypography(
      {
        ...terminal,
        // SAFETY: simulates a corrupted settings file that bypassed typed writers.
        editorFontSize: 'big' as unknown as number,
        editorFontWeight: Number.NaN,
        editorLineHeight: -1,
        // SAFETY: an unknown mode must not enable ligatures for a known ligature font.
        editorLigatures: 'yes' as unknown as 'on'
      },
      0
    )
    expect(typography).toMatchObject({
      fontSize: 14,
      fontWeight: 'normal',
      lineHeight: 0,
      fontLigatures: false
    })
  })
})
