import { describe, expect, it } from 'vitest'
import { parsePluginTerminalThemeArtifact } from './plugin-terminal-theme-artifact'

describe('plugin terminal theme artifacts', () => {
  it('accepts a bounded terminal palette', () => {
    expect(
      parsePluginTerminalThemeArtifact(
        JSON.stringify({
          schemaVersion: 1,
          mode: 'dark',
          terminal: {
            background: '#101010',
            foreground: '#f0f0f0',
            black: '#000000',
            red: '#ff0000'
          }
        })
      )
    ).toEqual({
      mode: 'dark',
      terminal: {
        background: '#101010',
        foreground: '#f0f0f0',
        black: '#000000',
        red: '#ff0000'
      }
    })
  })

  it('rejects invalid colors, unknown slots, and unusable palettes', () => {
    expect(() =>
      parsePluginTerminalThemeArtifact(
        JSON.stringify({
          schemaVersion: 1,
          terminal: { background: '#000', foreground: '#fff', black: 'expression(alert(1))' }
        })
      )
    ).toThrow(/invalid color/)
    expect(() =>
      parsePluginTerminalThemeArtifact(
        JSON.stringify({
          schemaVersion: 1,
          terminal: { background: '#000', foreground: '#fff', arbitrary: '#123456' }
        })
      )
    ).toThrow(/unknown terminal color slot/)
    expect(() =>
      parsePluginTerminalThemeArtifact(
        JSON.stringify({ schemaVersion: 1, terminal: { background: '#000', foreground: '#fff' } })
      )
    ).toThrow(/ANSI color/)
  })
})
