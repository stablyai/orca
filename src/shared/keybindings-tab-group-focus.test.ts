import { describe, expect, it } from 'vitest'
import {
  getEffectiveKeybindingsForAction,
  isKeybindingActionId,
  keybindingMatchesAction
} from './keybindings'
import { getWindowShortcutActionId, resolveWindowShortcutAction } from './window-shortcut-policy'

describe('split group keyboard navigation', () => {
  it.each(['tab.focusNextGroup', 'tab.focusPreviousGroup'])(
    'makes %s discoverable without claiming a default shortcut',
    (actionId) => {
      expect(isKeybindingActionId(actionId)).toBe(true)
      if (!isKeybindingActionId(actionId)) {
        throw new Error(`Missing split navigation action: ${actionId}`)
      }
      for (const platform of ['darwin', 'linux', 'win32'] as const) {
        expect(getEffectiveKeybindingsForAction(actionId, platform)).toEqual([])
      }
    }
  )

  it.each(['darwin', 'linux', 'win32'] as const)(
    'routes a custom group chord from app and terminal focus on %s',
    (platform) => {
      const input = {
        key: 'ArrowRight',
        code: 'ArrowRight',
        meta: platform === 'darwin',
        control: platform !== 'darwin',
        alt: true,
        shift: true
      }
      const overrides = { 'tab.focusNextGroup': ['Mod+Alt+Shift+ArrowRight'] }
      expect(resolveWindowShortcutAction(input, platform, overrides)).toEqual({
        type: 'focusTabGroup',
        direction: 1
      })
      for (const context of ['app', 'terminal'] as const) {
        const actionId = 'tab.focusNextGroup'
        if (!isKeybindingActionId(actionId)) {
          throw new Error('Missing next split navigation action')
        }
        expect(
          keybindingMatchesAction(actionId, input, platform, overrides, {
            context,
            terminalShortcutPolicy: 'terminal-first'
          })
        ).toBe(true)
      }
      const resolved = resolveWindowShortcutAction(input, platform, overrides)
      expect(resolved && getWindowShortcutActionId(resolved)).toBe('tab.focusNextGroup')
    }
  )
})
