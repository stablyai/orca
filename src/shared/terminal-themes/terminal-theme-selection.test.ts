import { describe, expect, it } from 'vitest'
import { terminalCustomThemeRemoval } from './terminal-theme-selection'

describe('deleting an imported terminal theme (#32138)', () => {
  const imported = {
    id: 'warp:dusk',
    name: 'Dusk',
    source: 'warp' as const,
    mode: 'dark' as const,
    terminal: { foreground: '#eeeeee', background: '#101020', red: '#ff5555' },
    importedAt: '2026-01-01T00:00:00.000Z'
  }
  const kept = { ...imported, id: 'warp:dawn', name: 'Dawn' }
  const settings = {
    terminalThemeDark: 'custom:warp:dusk',
    terminalThemeLight: 'custom:warp:dusk',
    terminalCustomThemes: [imported, kept],
    terminalColorOverrides: { background: '#000000' },
    terminalColorOverridesLight: { background: '#ffffff' }
  }

  it('undo keeps what the user changed after the delete', () => {
    const { updates, undo } = terminalCustomThemeRemoval(settings, 'warp:dusk')
    const afterDelete = { ...settings, ...updates, terminalCustomThemes: [kept] }
    const restored = undo({
      ...afterDelete,
      terminalThemeDark: 'Tokyo Night',
      terminalColorOverridesLight: { cursor: '#ff00ff' }
    })
    expect(restored).toEqual({ terminalCustomThemes: [kept, imported] })
    const reimported = { ...imported, name: 'Dusk v2' }
    expect(undo({ ...afterDelete, terminalCustomThemes: [kept, reimported] })).not.toHaveProperty(
      'terminalCustomThemes'
    )
  })
})
