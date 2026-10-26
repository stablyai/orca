import { describe, expect, it } from 'vitest'
import { isKeybindingInterceptedByMainProcess, KEYBINDING_DEFINITIONS } from './keybindings'
import { getWindowShortcutActionId, resolveWindowShortcutAction } from './window-shortcut-policy'

describe('main-process interception list', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'names exactly the actions resolveWindowShortcutAction routes on %s, minus dictation',
    (platform) => {
      const routed = KEYBINDING_DEFINITIONS.filter((definition) => {
        const action = resolveWindowShortcutAction(
          {
            type: 'keyDown',
            key: '1',
            code: 'Digit1',
            meta: platform === 'darwin',
            control: platform !== 'darwin',
            alt: true,
            shift: true
          },
          platform,
          { [definition.id]: ['Mod+Alt+Shift+1'] }
        )
        return action !== null && getWindowShortcutActionId(action) === definition.id
      })

      expect(
        routed.map((definition) => definition.id).filter((id) => id !== 'voice.dictation')
      ).toEqual(
        KEYBINDING_DEFINITIONS.filter(isKeybindingInterceptedByMainProcess).map(
          (definition) => definition.id
        )
      )
    }
  )
})
