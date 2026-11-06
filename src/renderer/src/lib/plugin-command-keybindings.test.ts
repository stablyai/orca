// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { ActivePluginCommand } from '@/store/plugin-panels'
import type { KeybindingOverrides } from '../../../shared/keybindings'
import {
  findPluginCommandForKeybinding,
  globalShortcutTargetYields,
  pluginCommandKeybindingActionId
} from './plugin-command-keybindings'

const command: ActivePluginCommand = {
  pluginKey: 'samples.tasks',
  pluginName: 'Tasks',
  id: 'open',
  title: 'Open Tasks',
  context: 'global',
  handler: { type: 'built-in', action: 'view.tasks' },
  keybindings: [{ key: 'Mod+Alt+T', when: 'global' }]
}

describe('plugin command keybindings', () => {
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
})

describe('globalShortcutTargetYields', () => {
  function editable(inNativeChat: boolean): HTMLElement {
    const root = document.createElement('div')
    if (inNativeChat) {
      root.dataset.nativeChatRoot = 'true'
    }
    const field = root.appendChild(document.createElement('div'))
    field.contentEditable = 'true'
    document.body.appendChild(root)
    return field
  }

  it('lets only the default rename chord through a native chat text field', () => {
    const yields = (letter: string, inNativeChat: boolean, overrides?: KeybindingOverrides) =>
      globalShortcutTargetYields(
        {
          key: letter,
          code: `Key${letter.toUpperCase()}`,
          metaKey: true,
          target: editable(inNativeChat)
        },
        'darwin',
        overrides,
        { context: 'app' }
      )

    expect(yields('r', true)).toBe(false)
    expect(yields('r', false)).toBe(true)
    expect(yields('z', true, { 'tab.rename': ['Mod+Z'] })).toBe(true)
  })
})
