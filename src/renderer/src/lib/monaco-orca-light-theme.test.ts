import { describe, expect, it } from 'vitest'
import { LIGHT_CONTENT_SURFACE_HEX } from './light-surface-tokens'
import { ORCA_LIGHT_MONACO_THEME_NAME, orcaLightMonacoThemeData } from './monaco-orca-light-theme'

describe('orca-light Monaco theme', () => {
  it('is named orca-light', () => {
    expect(ORCA_LIGHT_MONACO_THEME_NAME).toBe('orca-light')
  })

  it('inherits the stock light theme so syntax colors are unchanged', () => {
    expect(orcaLightMonacoThemeData.base).toBe('vs')
    expect(orcaLightMonacoThemeData.inherit).toBe(true)
    expect(orcaLightMonacoThemeData.rules).toEqual([])
  })

  it('paints the editor background family on the shared cream surface', () => {
    const cream = LIGHT_CONTENT_SURFACE_HEX
    expect(orcaLightMonacoThemeData.colors['editor.background']).toBe(cream)
    expect(orcaLightMonacoThemeData.colors['editorGutter.background']).toBe(cream)
    expect(orcaLightMonacoThemeData.colors['minimap.background']).toBe(cream)
  })
})
