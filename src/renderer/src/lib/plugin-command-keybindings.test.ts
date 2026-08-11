import { describe, expect, it } from 'vitest'
import {
  findKeybindingConflictsForDefinitions,
  KEYBINDING_DEFINITIONS
} from '../../../shared/keybindings'
import type { ActivePluginCommand } from '@/store/plugin-panels'
import {
  buildPluginCommandKeybindingDefinitions,
  findPluginCommandForKeybinding,
  getEffectivePluginCommandKeybindings,
  pluginCommandKeybindingActionId,
  pluginCommandKeybindingDefinition
} from './plugin-command-keybindings'

const command: ActivePluginCommand = {
  pluginKey: 'orca-samples.tasks',
  pluginName: 'Tasks',
  id: 'open',
  title: 'Open Tasks',
  context: 'global',
  handler: { type: 'built-in', action: 'view.tasks' },
  keybindings: [{ key: 'Mod+Alt+T', when: 'global' }]
}

describe('plugin command keybindings', () => {
  it('builds a stable dynamic action definition', () => {
    expect(pluginCommandKeybindingActionId(command)).toBe('plugin:orca-samples.tasks/open')
    expect(pluginCommandKeybindingDefinition(command)).toMatchObject({
      title: 'Open Tasks — Tasks',
      group: 'Plugins',
      defaultBindings: { darwin: ['Mod+Alt+T'] }
    })
  })

  it('lets user overrides replace or disable contributed defaults', () => {
    const actionId = pluginCommandKeybindingActionId(command)
    expect(getEffectivePluginCommandKeybindings(command, 'linux')).toEqual(['Mod+Alt+T'])
    expect(
      getEffectivePluginCommandKeybindings(command, 'linux', { [actionId]: ['Mod+Shift+T'] })
    ).toEqual(['Mod+Shift+T'])
    expect(getEffectivePluginCommandKeybindings(command, 'linux', { [actionId]: [] })).toEqual([])
  })

  it('keeps removed-plugin overrides inert and restores them on reinstall', () => {
    const actionId = pluginCommandKeybindingActionId(command)
    const overrides = { [actionId]: ['Mod+Shift+T'] }

    expect(buildPluginCommandKeybindingDefinitions([])).toEqual([])
    expect(getEffectivePluginCommandKeybindings(command, 'linux', overrides)).toEqual([
      'Mod+Shift+T'
    ])
  })

  it('matches effective overrides and honors explicit disablement', () => {
    const actionId = pluginCommandKeybindingActionId(command)
    const input = {
      key: 't',
      code: 'KeyT',
      control: true,
      meta: false,
      alt: false,
      shift: true
    }

    expect(findPluginCommandForKeybinding([command], input, 'linux', undefined, true)).toBeNull()
    expect(
      findPluginCommandForKeybinding(
        [command],
        input,
        'linux',
        { [actionId]: ['Mod+Shift+T'] },
        true
      )
    ).toBe(command)
    expect(
      findPluginCommandForKeybinding([command], input, 'linux', { [actionId]: [] }, true)
    ).toBeNull()
  })

  it('reports conflicts between plugin and built-in definitions', () => {
    const actionId = pluginCommandKeybindingActionId(command)
    const definitions = [...KEYBINDING_DEFINITIONS, pluginCommandKeybindingDefinition(command)]

    expect(
      findKeybindingConflictsForDefinitions(definitions, 'darwin', {
        [actionId]: ['Mod+P']
      })
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionIds: expect.arrayContaining([actionId, 'worktree.quickOpen'])
        })
      ])
    )
  })

  it('does not match worktree commands without an active worktree', () => {
    const worktreeCommand = { ...command, context: 'worktree' as const }
    const input = {
      key: 't',
      code: 'KeyT',
      control: true,
      meta: false,
      alt: true,
      shift: false
    }

    expect(
      findPluginCommandForKeybinding([worktreeCommand], input, 'linux', undefined, false)
    ).toBeNull()
    expect(findPluginCommandForKeybinding([worktreeCommand], input, 'linux', undefined, true)).toBe(
      worktreeCommand
    )
  })
})
