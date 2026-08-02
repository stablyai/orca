import { describe, expect, it } from 'vitest'

import {
  computeDiffEditorFontSize,
  computeEditorFontSize,
  resolveEditorFontFamily,
  resolveEditorFontFamilyOrInherit
} from './editor-font-zoom'

describe('editor font zoom', () => {
  it('keeps diff editors smaller than regular editor surfaces', () => {
    expect(computeDiffEditorFontSize(14, 0)).toBe(13.5)
    expect(computeDiffEditorFontSize(14, 3)).toBe(computeEditorFontSize(14, 3) - 0.5)
  })

  it('keeps diff editor font size within the editor safety bounds', () => {
    expect(computeDiffEditorFontSize(10, -6)).toBe(8)
    expect(computeDiffEditorFontSize(24, 18)).toBe(32)
  })
})

describe('resolveEditorFontFamily', () => {
  it('follows the terminal font when no editor font is set (byte-identical to legacy behavior)', () => {
    expect(resolveEditorFontFamily({ terminalFontFamily: 'D2Coding Nerd Font Mono' })).toBe(
      'D2Coding Nerd Font Mono'
    )
  })

  it('treats an empty/whitespace editor font as unset and follows the terminal font', () => {
    expect(resolveEditorFontFamily({ editorFontFamily: '', terminalFontFamily: 'Menlo' })).toBe(
      'Menlo'
    )
    expect(resolveEditorFontFamily({ editorFontFamily: '   ', terminalFontFamily: 'Menlo' })).toBe(
      'Menlo'
    )
  })

  it('uses the editor font override when the user opts in', () => {
    expect(
      resolveEditorFontFamily({ editorFontFamily: 'JetBrains Mono', terminalFontFamily: 'Menlo' })
    ).toBe('JetBrains Mono')
  })

  it('falls back to monospace when neither font is set', () => {
    expect(resolveEditorFontFamily(undefined)).toBe('monospace')
    expect(resolveEditorFontFamily({})).toBe('monospace')
  })
})

describe('resolveEditorFontFamilyOrInherit', () => {
  it('returns undefined (inherit UI font) when neither font is set', () => {
    expect(resolveEditorFontFamilyOrInherit({})).toBeUndefined()
    expect(resolveEditorFontFamilyOrInherit(undefined)).toBeUndefined()
  })

  it('follows the terminal font when no editor override is set', () => {
    expect(resolveEditorFontFamilyOrInherit({ terminalFontFamily: 'Menlo' })).toBe('Menlo')
  })

  it('uses the editor font override when set', () => {
    expect(
      resolveEditorFontFamilyOrInherit({
        editorFontFamily: 'Fira Code',
        terminalFontFamily: 'Menlo'
      })
    ).toBe('Fira Code')
  })
})
