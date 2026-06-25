import { describe, expect, it } from 'vitest'
import {
  makeCustomTerminalThemeSelection,
  normalizeTerminalCustomThemes,
  normalizeTerminalHexColor,
  parseCustomTerminalThemeSelection
} from './terminal-custom-themes'

describe('terminal custom themes', () => {
  it('normalizes colors and drops invalid theme records', () => {
    const themes = normalizeTerminalCustomThemes([
      {
        id: 'warp:Tokyo Night',
        name: 'Tokyo/Night\\Dark',
        source: 'warp',
        mode: 'dark',
        terminal: {
          background: '1a1b26',
          foreground: '#c0caf5',
          black: '#15161e',
          red: 'not-a-color'
        },
        importedAt: '2026-06-05T00:00:00.000Z',
        sourcePath: '/Users/alice/.warp/themes/tokyo.yaml'
      },
      {
        id: 'bad',
        name: 'Bad',
        source: 'warp',
        terminal: { background: '#000000' }
      }
    ])

    expect(themes).toEqual([
      {
        id: 'warp:tokyo-night',
        name: 'Tokyo Night Dark',
        source: 'warp',
        mode: 'dark',
        terminal: {
          background: '#1a1b26',
          foreground: '#c0caf5',
          black: '#15161e'
        },
        importedAt: '2026-06-05T00:00:00.000Z'
      }
    ])
  })

  it('deduplicates normalized ids with last write winning', () => {
    const themes = normalizeTerminalCustomThemes([
      {
        id: 'warp:dupe',
        name: 'First',
        source: 'warp',
        terminal: { background: '#000000', foreground: '#ffffff', black: '#111111' }
      },
      {
        id: 'warp:dupe',
        name: 'Second',
        source: 'warp',
        terminal: { background: '#000000', foreground: '#ffffff', red: '#ff0000' }
      }
    ])

    expect(themes).toHaveLength(1)
    expect(themes[0]?.name).toBe('Second')
    expect(themes[0]?.terminal.red).toBe('#ff0000')
  })

  it('requires at least one ANSI palette color', () => {
    expect(
      normalizeTerminalCustomThemes([
        {
          id: 'warp:cursor-only',
          name: 'Cursor Only',
          source: 'warp',
          terminal: { background: '#000000', foreground: '#ffffff', cursor: '#ffffff' }
        }
      ])
    ).toEqual([])
  })

  it('round-trips custom selection values', () => {
    expect(makeCustomTerminalThemeSelection('warp:tokyo-night')).toBe('custom:warp:tokyo-night')
    expect(parseCustomTerminalThemeSelection('custom:warp:tokyo-night')).toBe('warp:tokyo-night')
    expect(parseCustomTerminalThemeSelection('Builtin Tango Light')).toBeNull()
  })

  it('expands short hex colors', () => {
    expect(normalizeTerminalHexColor('abc')).toBe('#aabbcc')
  })
})
