import { describe, expect, it } from 'vitest'
import type { ActivePluginCommand } from '@/store/plugin-panels'
import { buildShortcutDefinitionCatalog } from './shortcut-definition-catalog'

describe('shortcut groups', () => {
  it('reports a plugin default that shadows a built-in shortcut', () => {
    const command: ActivePluginCommand = {
      pluginKey: 'samples.tasks',
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
      platform: 'darwin',
      missionControlConflictMessage: 'Blocked by Mission Control.'
    })

    expect(catalog.conflictByAction.get('plugin:samples.tasks/open')).toEqual([
      expect.stringContaining('Go to File')
    ])
  })

  it('reports a saved terminal override that main intercepts first', () => {
    const catalog = buildShortcutDefinitionCatalog({
      disabledTuiAgents: [],
      pluginCommands: [],
      keybindings: { 'terminal.splitRight': ['Mod+Alt+ArrowRight'] },
      platform: 'darwin',
      missionControlConflictMessage: 'Blocked by Mission Control.'
    })

    expect(catalog.conflictByAction.get('terminal.splitRight')).toEqual([
      expect.stringContaining('Worktree History Forward')
    ])
  })
})
