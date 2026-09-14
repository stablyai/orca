// Terminal focus context and the orca-first / terminal-first policy gate.
import { describe, expect, it } from 'vitest'
import {
  getEffectiveKeybindingsForAction,
  keybindingMatchesAction,
  matchKeybindingDigitIndex
} from './keybindings'

describe('keybindings', () => {
  it('keeps Orca-first terminal context backward compatible', () => {
    const ctrlP = {
      key: 'p',
      code: 'KeyP',
      control: true,
      meta: false,
      alt: false,
      shift: false
    }

    expect(keybindingMatchesAction('worktree.quickOpen', ctrlP, 'linux')).toBe(true)
    expect(
      keybindingMatchesAction('worktree.quickOpen', ctrlP, 'linux', undefined, {
        context: 'terminal',
        terminalShortcutPolicy: 'orca-first'
      })
    ).toBe(true)
    expect(
      keybindingMatchesAction('worktree.quickOpen', ctrlP, 'linux', undefined, {
        context: 'terminal',
        terminalShortcutPolicy: 'terminal-first'
      })
    ).toBe(false)
    expect(
      keybindingMatchesAction(
        'terminal.search',
        { key: 'f', code: 'KeyF', control: true, meta: false, alt: false, shift: false },
        'linux',
        undefined,
        { context: 'terminal', terminalShortcutPolicy: 'terminal-first' }
      )
    ).toBe(true)
  })

  it('keeps floating workspace tab shortcuts active in app focus even with terminal-first policy configured', () => {
    const panelFocus = {
      context: 'app',
      terminalShortcutPolicy: 'terminal-first'
    } as const

    expect(
      keybindingMatchesAction(
        'tab.rename',
        { key: 'r', code: 'KeyR', meta: true, control: false, alt: false, shift: false },
        'darwin',
        undefined,
        panelFocus
      )
    ).toBe(true)
    expect(
      matchKeybindingDigitIndex(
        'tab.selectByIndex',
        { key: '4', code: 'Digit4', meta: false, control: false, alt: true, shift: false },
        'linux',
        undefined,
        panelFocus
      )
    ).toBe(3)
  })

  it('keeps terminal-allowed app shortcuts active in terminal-first mode', () => {
    const deleteBinding = {
      key: 'Backspace',
      code: 'Backspace',
      control: true,
      meta: false,
      alt: false,
      shift: true
    }

    expect(
      keybindingMatchesAction(
        'floatingTerminal.toggle',
        { key: 'a', code: 'KeyA', control: true, meta: false, alt: true, shift: false },
        'linux',
        undefined,
        { context: 'terminal', terminalShortcutPolicy: 'terminal-first' }
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'tab.previousRecent',
        { key: 'Tab', code: 'Tab', control: true, meta: false, alt: false, shift: false },
        'linux',
        undefined,
        { context: 'terminal', terminalShortcutPolicy: 'terminal-first' }
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'workspace.delete',
        deleteBinding,
        'linux',
        { 'workspace.delete': ['Mod+Shift+Backspace'] },
        { context: 'terminal', terminalShortcutPolicy: 'terminal-first' }
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'worktree.palette',
        { key: 'j', code: 'KeyJ', control: false, meta: true, alt: false, shift: false },
        'darwin',
        undefined,
        { context: 'app', terminalShortcutPolicy: 'terminal-first' }
      )
    ).toBe(true)
  })

  it('keeps terminal clipboard shortcuts platform-native without stealing bare Ctrl+A', () => {
    expect(getEffectiveKeybindingsForAction('terminal.copySelection', 'darwin')).toEqual(['Mod+C'])
    expect(getEffectiveKeybindingsForAction('terminal.copySelection', 'linux')).toEqual([
      'Ctrl+Shift+C',
      'Ctrl+C'
    ])
    expect(getEffectiveKeybindingsForAction('terminal.selectAll', 'darwin')).toEqual(['Mod+A'])
    expect(getEffectiveKeybindingsForAction('terminal.selectAll', 'linux')).toEqual([
      'Ctrl+Shift+A'
    ])
    expect(getEffectiveKeybindingsForAction('terminal.paste', 'darwin')).toEqual(['Mod+V'])
    expect(getEffectiveKeybindingsForAction('terminal.paste', 'linux')).toEqual([
      'Ctrl+V',
      'Ctrl+Shift+V',
      'Shift+Insert'
    ])
    expect(
      keybindingMatchesAction(
        'terminal.copySelection',
        { key: 'c', code: 'KeyC', control: false, meta: true, alt: false, shift: false },
        'darwin'
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'terminal.copySelection',
        { key: 'c', code: 'KeyC', control: true, meta: false, alt: false, shift: true },
        'linux'
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'terminal.copySelection',
        { key: 'c', code: 'KeyC', control: true, meta: false, alt: false, shift: false },
        'linux'
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'terminal.selectAll',
        { key: 'a', code: 'KeyA', control: false, meta: true, alt: false, shift: false },
        'darwin'
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'terminal.selectAll',
        { key: 'a', code: 'KeyA', control: true, meta: false, alt: false, shift: true },
        'linux'
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'terminal.selectAll',
        { key: 'a', code: 'KeyA', control: true, meta: false, alt: false, shift: false },
        'linux'
      )
    ).toBe(false)
    expect(
      keybindingMatchesAction(
        'terminal.paste',
        { key: 'v', code: 'KeyV', control: true, meta: false, alt: false, shift: false },
        'linux'
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'terminal.paste',
        { key: 'Insert', code: 'Insert', control: false, meta: false, alt: false, shift: true },
        'linux'
      )
    ).toBe(true)
  })
})
