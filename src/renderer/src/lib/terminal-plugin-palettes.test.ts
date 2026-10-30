import { describe, expect, it } from 'vitest'
import {
  refreshedTerminalPluginPalettes,
  withTerminalPluginPalettes
} from './terminal-plugin-palettes'

const dusk = {
  id: 'plugin:samples.dusk/dusk' as const,
  pluginKey: 'samples.dusk',
  pluginName: 'Dusk',
  label: 'Dusk',
  mode: 'dark' as const,
  terminal: { background: '#1b1430', foreground: '#e8e0ff', red: '#ff6b8b' }
}
const base = {
  terminalThemeDark: 'Builtin Dark',
  terminalThemeLight: '',
  terminalPluginPalettes: []
}

describe('terminal plugin palette snapshots', () => {
  it('saves the palette of a newly selected plugin theme and drops unselected ones', () => {
    const selected = withTerminalPluginPalettes(base, { terminalThemeDark: dusk.id }, [dusk])
    expect(selected.terminalPluginPalettes).toEqual([{ id: dusk.id, colors: dusk.terminal }])

    const cleared = withTerminalPluginPalettes(
      {
        ...base,
        terminalThemeDark: dusk.id,
        terminalPluginPalettes: selected.terminalPluginPalettes
      },
      { terminalThemeDark: 'Builtin Dark' },
      [dusk]
    )
    expect(cleared.terminalPluginPalettes).toEqual([])
  })

  it('refreshes after a plugin update and keeps the last palette while the plugin is off', () => {
    const settings = {
      ...base,
      terminalThemeDark: dusk.id,
      terminalPluginPalettes: [{ id: dusk.id, colors: dusk.terminal }]
    }
    expect(refreshedTerminalPluginPalettes(settings, [dusk])).toBeNull()
    expect(refreshedTerminalPluginPalettes(settings, [])).toBeNull()
    const updated = { ...dusk, terminal: { ...dusk.terminal, red: '#ff0000' } }
    expect(refreshedTerminalPluginPalettes(settings, [updated])).toEqual({
      terminalPluginPalettes: [{ id: dusk.id, colors: updated.terminal }]
    })
  })
})
