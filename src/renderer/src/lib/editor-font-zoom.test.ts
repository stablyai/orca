import { describe, expect, it } from 'vitest'

import {
  computeDiffEditorFontSize,
  computeEditorFontSize,
  computeEditorLineHeight,
  resolveEditorBaseFontSize,
  resolveEditorFontFamily,
  resolveEditorFontStack
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

describe('computeEditorLineHeight', () => {
  it('keeps the legacy 20px row at and below the default size', () => {
    for (const fontSize of [8, 10, 13, 14]) {
      expect(computeEditorLineHeight(fontSize)).toBe(20)
    }
  })

  it('grows rows with larger fonts so adjacent lines cannot overlap', () => {
    expect(computeEditorLineHeight(15)).toBe(22)
    expect(computeEditorLineHeight(24)).toBe(35)
    expect(computeEditorLineHeight(32)).toBe(46)
  })
})

describe('resolveEditorBaseFontSize', () => {
  it('follows the terminal size when no editor size is set (byte-identical to legacy behavior)', () => {
    expect(resolveEditorBaseFontSize({ terminalFontSize: 11 })).toBe(11)
    expect(resolveEditorBaseFontSize({ editorFontSize: undefined, terminalFontSize: 11 })).toBe(11)
  })

  it('uses the editor size override when the user opts in', () => {
    expect(resolveEditorBaseFontSize({ editorFontSize: 18, terminalFontSize: 11 })).toBe(18)
  })

  it('ignores a corrupt editor size instead of handing NaN to Monaco', () => {
    for (const editorFontSize of [Number.NaN, Number.POSITIVE_INFINITY, 0, -4]) {
      expect(resolveEditorBaseFontSize({ editorFontSize, terminalFontSize: 11 })).toBe(11)
    }
  })

  it('falls back to 13 when neither size is set', () => {
    expect(resolveEditorBaseFontSize(undefined)).toBe(13)
    expect(resolveEditorBaseFontSize(null)).toBe(13)
    expect(resolveEditorBaseFontSize({})).toBe(13)
  })

  it('lets editor zoom stack on top of the editor size', () => {
    const base = resolveEditorBaseFontSize({ editorFontSize: 18, terminalFontSize: 11 })
    expect(computeEditorFontSize(base, 2)).toBe(20)
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

describe('resolveEditorFontStack', () => {
  it('wraps a single family name with the monospace fallback chain', () => {
    const stack = resolveEditorFontStack({ editorFontFamily: 'JetBrains Mono' })
    expect(stack.startsWith('"JetBrains Mono", "SF Mono"')).toBe(true)
    expect(stack.endsWith(', monospace')).toBe(true)
  })

  it('passes a comma-separated stack through unchanged', () => {
    expect(resolveEditorFontStack({ editorFontFamily: 'JetBrains Mono, monospace' })).toBe(
      'JetBrains Mono, monospace'
    )
    expect(resolveEditorFontStack({ terminalFontFamily: '"Fira Code", Menlo' })).toBe(
      '"Fira Code", Menlo'
    )
  })

  it('falls back to the full chain when no font is set', () => {
    expect(resolveEditorFontStack({})).toMatch(/^"SF Mono", .*, monospace$/)
  })
})
