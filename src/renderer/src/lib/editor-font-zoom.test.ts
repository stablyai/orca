import { describe, expect, it } from 'vitest'

import {
  computeDiffEditorFontSize,
  computeEditorFontSize,
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
