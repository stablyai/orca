import { describe, expect, it } from 'vitest'

import {
  computeDiffEditorFontSize,
  computeEditorFontSize,
  resolveEditorFontFamily,
  resolveEditorFontFamilyOrInherit,
  resolveEditorFontWeight,
  monacoAutomaticLineHeightRatio,
  normalizeEditorLineHeight,
  resolveEditorLineHeight
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

describe('resolveEditorFontWeight', () => {
  it('follows the terminal weight when no editor override is set', () => {
    expect(resolveEditorFontWeight({ terminalFontWeight: 400 })).toBe('400')
    expect(resolveEditorFontWeight({ editorFontWeight: 0, terminalFontWeight: 400 })).toBe('400')
  })

  it('uses the opt-in editor weight override instead of the terminal weight', () => {
    expect(resolveEditorFontWeight({ editorFontWeight: 300, terminalFontWeight: 600 })).toBe('300')
  })

  it('falls back to the default terminal weight when neither weight is set', () => {
    expect(resolveEditorFontWeight(undefined)).toBe('500')
    expect(resolveEditorFontWeight({})).toBe('500')
  })

  it('clamps out-of-range overrides into the supported 100-900 band', () => {
    expect(resolveEditorFontWeight({ editorFontWeight: 5000 })).toBe('900')
    expect(resolveEditorFontWeight({ editorFontWeight: 50 })).toBe('100')
  })
})

describe('resolveEditorLineHeight', () => {
  // Monaco reads 0 as "compute from the font size", so an unset setting must stay 0
  // rather than re-flowing every open file the first time this ships.
  it('stays on Monaco automatic spacing when unset', () => {
    expect(resolveEditorLineHeight(undefined)).toBe(0)
    expect(resolveEditorLineHeight({})).toBe(0)
    expect(resolveEditorLineHeight({ editorLineHeight: 0 })).toBe(0)
  })

  it('passes an opted-in multiplier through', () => {
    expect(resolveEditorLineHeight({ editorLineHeight: 1.2 })).toBe(1.2)
  })

  it('clamps out-of-range values into the supported band', () => {
    expect(normalizeEditorLineHeight(9)).toBe(3)
    expect(normalizeEditorLineHeight(0.2)).toBe(1)
  })

  it('rejects values Monaco would misread as absolute pixels', () => {
    expect(normalizeEditorLineHeight(Number.NaN)).toBe(0)
    expect(normalizeEditorLineHeight(-4)).toBe(0)
  })
})

describe('monacoAutomaticLineHeightRatio', () => {
  it('mirrors Monaco GOLDEN_LINE_HEIGHT_RATIO per platform', () => {
    expect(monacoAutomaticLineHeightRatio('darwin')).toBe(1.5)
    expect(monacoAutomaticLineHeightRatio('linux')).toBe(1.35)
    expect(monacoAutomaticLineHeightRatio('win32')).toBe(1.35)
  })
})
