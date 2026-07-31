import { describe, expect, it } from 'vitest'
import type { KeybindingDefinition } from '../../../../shared/keybindings'
import type { ActivePluginCommand } from '@/store/plugin-panels'
import { buildShortcutDefinitionCatalog } from './shortcut-definition-catalog'
import { groupDefinitions } from './shortcut-groups'

const pluginDefinition: KeybindingDefinition = {
  id: 'plugin:orca-samples.tasks/open',
  title: 'Open Tasks — Tasks',
  group: 'Plugins',
  scope: 'global',
  searchKeywords: ['plugin', 'tasks'],
  defaultBindings: {
    darwin: ['Mod+Alt+T'],
    linux: ['Mod+Alt+T'],
    win32: ['Mod+Alt+T']
  }
}

describe('shortcut groups', () => {
  it('includes dynamic plugin command definitions in Settings', () => {
    expect(groupDefinitions([], [pluginDefinition])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Plugins',
          items: [pluginDefinition]
        })
      ])
    )
  })

  it('reports a plugin default that shadows a built-in shortcut', () => {
    const command: ActivePluginCommand = {
      pluginKey: 'orca-samples.tasks',
      pluginName: 'Tasks',
      id: 'open',
      title: 'Open Tasks',
      context: 'global',
      handler: { type: 'built-in', action: 'view.tasks' },
      keybindings: [{ key: 'Mod+P', when: 'global' }]
    }

    const catalog = buildShortcutDefinitionCatalog({
      disabledTuiAgents: [],
      pluginCommands: [command],
      keybindings: {},
      platform: 'darwin'
    })

    expect(catalog.conflictByAction.get('plugin:orca-samples.tasks/open')).toEqual([
      expect.stringContaining('Go to File')
    ])
  })

  it('reports a file override the loader dropped for conflicting', () => {
    // Why: the loader strips a conflicting override before the active map
    // reaches the catalog, so only the snapshot can still explain the row.
    const catalog = buildShortcutDefinitionCatalog({
      disabledTuiAgents: [],
      pluginCommands: [],
      keybindings: {},
      keybindingSnapshot: {
        path: '/tmp/keybindings.json',
        platform: 'darwin',
        exists: true,
        overrides: {},
        commonOverrides: { 'terminal.splitRight': ['Mod+Alt+ArrowRight'] },
        platformOverrides: { darwin: {}, linux: {}, win32: {} },
        diagnostics: []
      },
      platform: 'darwin'
    })

    expect(catalog.conflictByAction.get('terminal.splitRight')).toEqual([
      '⌘⌥→ was ignored — it conflicts with Worktree History Forward.'
    ])
    expect(catalog.conflictByAction.has('worktree.history.forward')).toBe(false)
  })
})
