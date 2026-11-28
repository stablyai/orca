import { describe, expect, it } from 'vitest'
import type { ActivePluginCommand } from '@/store/plugins/catalog/plugin-contribution-catalog'
import { findPluginCommandForKeybinding } from './plugin-command-keybindings'
import {
  isPluginCommandInactiveFloatingWorkspaceAlias,
  isPluginReplacedActionDisclosed
} from './plugin-command-floating-workspace'
import { shadowedKeybindingTitles } from '@/components/plugins/presentation/plugin-keybinding-conflicts'
import { inactiveFloatingWorkspaceActionIds } from '../../../../../shared/settings/floating-workspace-cohort'

const CHORD = {
  key: 'k',
  code: 'KeyK',
  metaKey: true,
  altKey: true,
  ctrlKey: false,
  shiftKey: false
}

function command(
  id: string,
  handler: ActivePluginCommand['handler'],
  replaces?: string
): ActivePluginCommand {
  return {
    id,
    title: id,
    context: 'global',
    handler,
    keybindings: [{ key: 'Mod+Alt+K', when: 'global' }],
    ...(replaces ? { replaces } : {}),
    pluginKey: 'test-plugin',
    pluginName: 'Test'
  }
}

const alias = command('alias', { type: 'built-in', action: 'floatingWorkspace.maximize' })
const replacement = command('replacement', { type: 'worker' }, 'floatingWorkspace.maximize')
const unrelated = command('unrelated', { type: 'built-in', action: 'sidebar.left.toggle' })

describe('plugin commands while the floating workspace is inactive', () => {
  it('drops only aliases of an inactive floating action from shortcut dispatch', () => {
    const find = (commands: ActivePluginCommand[], active: boolean) =>
      findPluginCommandForKeybinding(commands, CHORD, 'darwin', {}, true, {}, active)?.id ?? null
    expect(find([alias], false)).toBeNull()
    expect(find([alias], true)).toBe('alias')
    // A worker that replaces the action is its own command, so its own chord still runs it.
    expect(find([replacement], false)).toBe('replacement')
    expect(find([unrelated], false)).toBe('unrelated')
    // Sharing a chord, the inert alias steps aside instead of swallowing it.
    expect(find([alias, unrelated], false)).toBe('unrelated')
    expect(find([alias, unrelated], true)).toBe('alias')
  })

  it('hides Run and status-bar presses for inactive aliases only', () => {
    expect(isPluginCommandInactiveFloatingWorkspaceAlias(alias, false)).toBe(true)
    expect(isPluginCommandInactiveFloatingWorkspaceAlias(alias, true)).toBe(false)
    expect(isPluginCommandInactiveFloatingWorkspaceAlias(replacement, false)).toBe(false)
    expect(isPluginCommandInactiveFloatingWorkspaceAlias(unrelated, false)).toBe(false)
  })

  it('discloses a floating replacement to the existing cohort even while it is off', () => {
    expect(isPluginReplacedActionDisclosed('floatingWorkspace.maximize', true)).toBe(true)
    expect(isPluginReplacedActionDisclosed('floatingWorkspace.maximize', false)).toBe(false)
    expect(isPluginReplacedActionDisclosed('sidebar.left.toggle', false)).toBe(true)
  })

  it('never names an inactive action as the shortcut a plugin binding replaces', () => {
    expect(
      shadowedKeybindingTitles('Mod+Alt+A', 'darwin', {}, inactiveFloatingWorkspaceActionIds(false))
    ).toEqual([])
    expect(shadowedKeybindingTitles('Mod+Alt+A', 'darwin', {})).not.toEqual([])
  })
})
