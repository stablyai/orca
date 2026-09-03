import { describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'
import {
  PURE_BLACK_MONACO_THEME,
  registerPureBlackMonacoTheme,
  resolveMonacoDarkThemeName
} from './monaco-editor-theme'

describe('resolveMonacoDarkThemeName', () => {
  it('keeps vs-dark unless pure black is selected', () => {
    expect(resolveMonacoDarkThemeName(undefined)).toBe('vs-dark')
    expect(resolveMonacoDarkThemeName('default')).toBe('vs-dark')
  })

  it('routes pure black to the registered Orca theme', () => {
    expect(resolveMonacoDarkThemeName('pure-black')).toBe(PURE_BLACK_MONACO_THEME)
  })
})

describe('registerPureBlackMonacoTheme', () => {
  it('inherits vs-dark so only the surfaces move to #000', () => {
    const defineTheme = vi.fn()
    registerPureBlackMonacoTheme({ editor: { defineTheme } } as unknown as typeof Monaco)

    expect(defineTheme).toHaveBeenCalledTimes(1)
    const [name, data] = defineTheme.mock.calls[0] as [string, Monaco.editor.IStandaloneThemeData]
    expect(name).toBe(PURE_BLACK_MONACO_THEME)
    expect(data.base).toBe('vs-dark')
    expect(data.inherit).toBe(true)
    expect(data.rules).toEqual([])
    expect(data.colors['editor.background']).toBe('#000000')
  })
})
