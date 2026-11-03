import { describe, expect, it } from 'vitest'
import { getKeybindingDefinition } from './keybindings/definitions'
import { getWindowShortcutActionId, resolveWindowShortcutAction } from './window-shortcut-policy'

const linuxInput = {
  code: 'KeyL',
  key: 'L',
  meta: false,
  control: true,
  alt: false,
  shift: true
}

const macInput = { ...linuxInput, meta: true, control: false }

const binding = { 'workspace.nextAttention': ['Mod+Shift+L'] }

describe('next-attention workspace shortcut', () => {
  it('ships without a default chord on any platform', () => {
    expect(getKeybindingDefinition('workspace.nextAttention')?.defaultBindings).toEqual({
      darwin: [],
      linux: [],
      win32: []
    })
    expect(resolveWindowShortcutAction(linuxInput, 'linux')).toBeNull()
  })

  it('resolves a custom binding on macOS and Linux', () => {
    expect(resolveWindowShortcutAction(macInput, 'darwin', binding)).toEqual({
      type: 'jumpToNextAttention'
    })
    expect(resolveWindowShortcutAction(linuxInput, 'linux', binding)).toEqual({
      type: 'jumpToNextAttention'
    })
  })

  it('still resolves while a terminal owns focus under terminal-first', () => {
    expect(
      resolveWindowShortcutAction(linuxInput, 'linux', binding, {
        context: 'terminal',
        terminalShortcutPolicy: 'terminal-first'
      })
    ).toEqual({ type: 'jumpToNextAttention' })
  })

  it('maps the action back to its keybinding id', () => {
    expect(getWindowShortcutActionId({ type: 'jumpToNextAttention' })).toBe(
      'workspace.nextAttention'
    )
  })
})
