// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  function editable(inNativeChat: boolean): HTMLElement {
    const root = document.createElement('div')
    if (inNativeChat) {
      root.dataset.nativeChatRoot = 'true'
    }
    const field = root.appendChild(document.createElement('div'))
    field.contentEditable = 'true'
    if (inNativeChat) {
      field.dataset.nativeChatPromptEditor = ''
    }
    document.body.appendChild(root)
    return field
  }

  it('lets rename through the chat prompt while protecting ordinary fields and editing chords', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mac')
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
