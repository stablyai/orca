import { describe, expect, it } from 'vitest'
import { resolveWindowShortcutAction, type WindowShortcutInput } from './window-shortcut-policy'
import type { KeybindingOverrides } from './keybindings'

describe('workspace repo shortcuts', () => {
  const chord = (digit: string, mods: Partial<WindowShortcutInput>): WindowShortcutInput => ({
    key: digit,
    code: `Digit${digit}`,
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...mods
  })

  it('does not bind Cmd+Option+digits to a repo, which would shadow other chords', () => {
    expect(resolveWindowShortcutAction(chord('3', { meta: true, alt: true }), 'darwin')).toBeNull()
  })

  it('resolves remapped next and previous repo chords', () => {
    const overrides: KeybindingOverrides = {
      'workspace.nextRepo': ['Mod+Alt+ArrowDown'],
      'workspace.previousRepo': ['Mod+Alt+ArrowUp']
    }
    const arrow = (code: string): WindowShortcutInput => ({
      key: code,
      code,
      meta: true,
      control: false,
      alt: true,
      shift: false
    })
    expect(resolveWindowShortcutAction(arrow('ArrowDown'), 'darwin', overrides)).toEqual({
      type: 'selectWorkspaceRepo',
      selection: { kind: 'next' }
    })
    expect(resolveWindowShortcutAction(arrow('ArrowUp'), 'darwin', overrides)).toEqual({
      type: 'selectWorkspaceRepo',
      selection: { kind: 'previous' }
    })
    expect(resolveWindowShortcutAction(arrow('ArrowDown'), 'darwin')).toBeNull()
  })
})
