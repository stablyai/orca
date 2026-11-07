import { describe, expect, it } from 'vitest'
import {
  disambiguatedContentPluginNames,
  disambiguatedPluginContentLabels
} from './plugin-name-disambiguation'

describe('plugin content labels', () => {
  it('suffixes the community theme, never the official one, by its key publisher', () => {
    const labels = disambiguatedPluginContentLabels([
      {
        id: 'plugin:stablyai.orca-catppuccin-theme/mocha',
        pluginKey: 'stablyai.orca-catppuccin-theme',
        label: 'Catppuccin Mocha'
      },
      {
        id: 'plugin:vale-c.catppuccin/mocha',
        pluginKey: 'vale-c.catppuccin',
        label: 'Catppuccin Mocha'
      },
      {
        id: 'plugin:vale-c.catppuccin/latte',
        pluginKey: 'vale-c.catppuccin',
        label: 'Catppuccin Latte'
      }
    ])
    expect(labels.get('plugin:stablyai.orca-catppuccin-theme/mocha')).toBe('Catppuccin Mocha')
    expect(labels.get('plugin:vale-c.catppuccin/mocha')).toBe('Catppuccin Mocha (vale-c)')
    expect(labels.get('plugin:vale-c.catppuccin/latte')).toBe('Catppuccin Latte')
  })

  it("keeps Orca's built-in names plain and suffixes a plugin entry sharing one", () => {
    const labels = disambiguatedPluginContentLabels(
      [{ id: 'plugin:acme.dracula/d', pluginKey: 'acme.dracula', label: 'Dracula' }],
      ['Dracula']
    )
    expect(labels.get('plugin:acme.dracula/d')).toBe('Dracula (acme)')
  })

  it('names clashing plugins once each', () => {
    const names = disambiguatedContentPluginNames([
      { pluginKey: 'stablyai.orca-catppuccin-theme', pluginName: 'Catppuccin for Orca' },
      { pluginKey: 'vale-c.catppuccin', pluginName: 'Catppuccin for Orca' },
      { pluginKey: 'vale-c.catppuccin', pluginName: 'Catppuccin for Orca' }
    ])
    expect(names.get('stablyai.orca-catppuccin-theme')).toBe('Catppuccin for Orca')
    expect(names.get('vale-c.catppuccin')).toBe('Catppuccin for Orca (vale-c)')
  })
})
