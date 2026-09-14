// Digit-index ranges for tab and workspace selection chords.
import { describe, expect, it } from 'vitest'
import {
  findKeybindingConflicts,
  isDigitIndexActionId,
  keybindingFromInputForAction,
  matchKeybindingDigitIndex,
  normalizeKeybindingArrayForAction,
  normalizeKeybindingListForAction
} from './keybindings'

describe('digit-index shortcuts', () => {
  const digitInput = (
    digit: string,
    modifiers: { meta?: boolean; control?: boolean; alt?: boolean; shift?: boolean }
  ): Parameters<typeof matchKeybindingDigitIndex>[1] => ({
    key: digit,
    code: `Digit${digit}`,
    meta: Boolean(modifiers.meta),
    control: Boolean(modifiers.control),
    alt: Boolean(modifiers.alt),
    shift: Boolean(modifiers.shift)
  })

  it('flags the two ranged actions as digit-index rows', () => {
    expect(isDigitIndexActionId('tab.selectByIndex')).toBe(true)
    expect(isDigitIndexActionId('workspace.selectByIndex')).toBe(true)
    expect(isDigitIndexActionId('tab.newTerminal')).toBe(false)
  })

  it('resolves the default ranges per platform', () => {
    // macOS: workspace = Cmd+1-9, tab = Ctrl+1-9.
    expect(
      matchKeybindingDigitIndex(
        'workspace.selectByIndex',
        digitInput('3', { meta: true }),
        'darwin'
      )
    ).toBe(2)
    expect(
      matchKeybindingDigitIndex('tab.selectByIndex', digitInput('3', { meta: true }), 'darwin')
    ).toBeNull()
    expect(
      matchKeybindingDigitIndex('tab.selectByIndex', digitInput('3', { control: true }), 'darwin')
    ).toBe(2)

    // Windows/Linux: workspace = Ctrl+1-9, tab = Alt+1-9.
    expect(
      matchKeybindingDigitIndex(
        'workspace.selectByIndex',
        digitInput('4', { control: true }),
        'linux'
      )
    ).toBe(3)
    expect(
      matchKeybindingDigitIndex('tab.selectByIndex', digitInput('4', { alt: true }), 'linux')
    ).toBe(3)
  })

  it('ignores non-range presses and extra modifiers', () => {
    expect(
      matchKeybindingDigitIndex(
        'workspace.selectByIndex',
        digitInput('3', { meta: true, shift: true }),
        'darwin'
      )
    ).toBeNull()
    expect(
      matchKeybindingDigitIndex(
        'tab.selectByIndex',
        { key: 'p', code: 'KeyP', meta: false, control: true, alt: false, shift: false },
        'darwin'
      )
    ).toBeNull()
  })

  it('honors custom bindings, including swapping tab and workspace modifiers', () => {
    const swapped = {
      'tab.selectByIndex': ['Mod+1'],
      'workspace.selectByIndex': ['Ctrl+1']
    }
    expect(
      matchKeybindingDigitIndex(
        'tab.selectByIndex',
        digitInput('5', { meta: true }),
        'darwin',
        swapped
      )
    ).toBe(4)
    expect(
      matchKeybindingDigitIndex(
        'workspace.selectByIndex',
        digitInput('5', { control: true }),
        'darwin',
        swapped
      )
    ).toBe(4)
    // A disabled (empty) override never fires.
    expect(
      matchKeybindingDigitIndex('tab.selectByIndex', digitInput('5', { control: true }), 'darwin', {
        'tab.selectByIndex': []
      })
    ).toBeNull()
  })

  it('respects the terminal-first context gate', () => {
    expect(
      matchKeybindingDigitIndex(
        'tab.selectByIndex',
        digitInput('2', { control: true }),
        'darwin',
        undefined,
        {
          context: 'terminal',
          terminalShortcutPolicy: 'terminal-first'
        }
      )
    ).toBeNull()
    expect(
      matchKeybindingDigitIndex(
        'tab.selectByIndex',
        digitInput('2', { control: true }),
        'darwin',
        undefined,
        {
          context: 'terminal',
          terminalShortcutPolicy: 'orca-first'
        }
      )
    ).toBe(1)
  })

  it('canonicalizes a captured chord to the digit-1 representative', () => {
    expect(
      keybindingFromInputForAction(
        'workspace.selectByIndex',
        digitInput('7', { meta: true }),
        'darwin'
      )
    ).toEqual({ ok: true, value: 'Mod+1' })
    expect(
      keybindingFromInputForAction(
        'tab.selectByIndex',
        digitInput('9', { control: true }),
        'darwin'
      )
    ).toEqual({ ok: true, value: 'Ctrl+1' })
    // A non-number chord is rejected with guidance.
    expect(
      keybindingFromInputForAction(
        'tab.selectByIndex',
        { key: 'p', code: 'KeyP', meta: true, control: false, alt: false, shift: false },
        'darwin'
      )
    ).toMatchObject({ ok: false })
  })

  it('allows extra modifiers (e.g. Shift) on a digit-index chord', () => {
    expect(
      keybindingFromInputForAction(
        'tab.selectByIndex',
        digitInput('5', { control: true, shift: true }),
        'darwin'
      )
    ).toEqual({ ok: true, value: 'Ctrl+Shift+1' })
    expect(normalizeKeybindingListForAction('workspace.selectByIndex', 'Mod+Shift+5')).toEqual([
      'Mod+Shift+1'
    ])
  })

  it('matches via the physical-code fallback when the key value is unavailable', () => {
    // macOS/IME edge cases can leave key empty while code carries the digit.
    expect(
      matchKeybindingDigitIndex(
        'tab.selectByIndex',
        { key: '', code: 'Digit5', meta: false, control: true, alt: false, shift: false },
        'darwin'
      )
    ).toBe(4)
  })

  it('canonicalizes stored bindings and rejects non-number chords', () => {
    expect(normalizeKeybindingListForAction('workspace.selectByIndex', 'Mod+5')).toEqual(['Mod+1'])
    expect(normalizeKeybindingArrayForAction('tab.selectByIndex', ['Ctrl+9'])).toEqual(['Ctrl+1'])
    expect(normalizeKeybindingListForAction('tab.selectByIndex', 'Mod+P')).toMatchObject({
      ok: false
    })
  })

  it('lets the two ranges swap modifiers without a false conflict', () => {
    // The headline use case: tab → Cmd, workspace → Ctrl. They live in
    // different scopes, so neither edit is blocked as a conflict.
    expect(
      findKeybindingConflicts('darwin', {
        'tab.selectByIndex': ['Mod+1'],
        'workspace.selectByIndex': ['Ctrl+1']
      })
    ).toEqual([])
  })
})
