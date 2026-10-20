// Directional tab-group focus shortcuts (vim h/j/k/l).
import { describe, expect, it } from 'vitest'
import {
  findKeybindingConflicts,
  getEffectiveKeybindingsForAction,
  keybindingMatchesAction
} from './keybindings'
import type { KeybindingActionId } from './keybindings'
import { matchTabGroupFocusDirection } from './workspace-layout/tab-group-neighbor'

const ACTIONS = [
  ['tab.focusGroupLeft', 'H', 'left', '˙'],
  ['tab.focusGroupDown', 'J', 'down', '∆'],
  ['tab.focusGroupUp', 'K', 'up', '˚'],
  ['tab.focusGroupRight', 'L', 'right', '¬']
] as const satisfies readonly (readonly [KeybindingActionId, string, string, string])[]

function chord(key: string, code: string) {
  return { key, code, control: true, alt: true, meta: false, shift: false }
}

describe('tab group focus shortcuts', () => {
  it.each(ACTIONS)('%s defaults to Ctrl+Alt+%s on macOS only', (actionId, letter) => {
    expect(getEffectiveKeybindingsForAction(actionId, 'darwin')).toEqual([`Ctrl+Alt+${letter}`])
    expect(getEffectiveKeybindingsForAction(actionId, 'linux')).toEqual([])
    expect(getEffectiveKeybindingsForAction(actionId, 'win32')).toEqual([])
  })

  it.each(ACTIONS)(
    '%s matches both the plain and the Option-composed key on macOS',
    (actionId, letter, _direction, composed) => {
      const code = `Key${letter}`
      expect(keybindingMatchesAction(actionId, chord(letter.toLowerCase(), code), 'darwin')).toBe(
        true
      )
      expect(keybindingMatchesAction(actionId, chord(composed, code), 'darwin')).toBe(true)
    }
  )

  it('does not fire without Ctrl or with Cmd', () => {
    const optionOnly = {
      key: '˙',
      code: 'KeyH',
      control: false,
      alt: true,
      meta: false,
      shift: false
    }
    const cmdCtrlOption = { ...chord('h', 'KeyH'), meta: true }
    expect(keybindingMatchesAction('tab.focusGroupLeft', optionOnly, 'darwin')).toBe(false)
    expect(keybindingMatchesAction('tab.focusGroupLeft', cmdCtrlOption, 'darwin')).toBe(false)
  })

  it('stays active inside a terminal under terminal-first', () => {
    expect(
      keybindingMatchesAction('tab.focusGroupRight', chord('l', 'KeyL'), 'darwin', undefined, {
        context: 'terminal',
        terminalShortcutPolicy: 'terminal-first'
      })
    ).toBe(true)
  })

  it('maps each matching action to its direction', () => {
    for (const [actionId, , direction] of ACTIONS) {
      expect(matchTabGroupFocusDirection((candidate) => candidate === actionId)).toBe(direction)
    }
    expect(matchTabGroupFocusDirection(() => false)).toBeNull()
  })

  it('adds no default conflicts on any platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const conflicts = findKeybindingConflicts(platform).filter((conflict) =>
        conflict.actionIds.some((actionId) => actionId.startsWith('tab.focusGroup'))
      )
      expect(conflicts).toEqual([])
    }
  })
})
