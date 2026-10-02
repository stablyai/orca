import { describe, expect, it } from 'vitest'
import {
  findKeybindingConflicts,
  formatKeybinding,
  isMouseBinding,
  keybindingFromInputForAction,
  keybindingMatchesInput,
  normalizeKeybinding,
  normalizeKeybindingArrayForAction,
  normalizeStoredKeybindingArrayForAction,
  splitBindingsByInputKind,
  splitOverridesByInputKind,
  unionKeybindingOverrides,
  unionPlatformKeybindingOverrides
} from './keybindings'

describe('mouse button keybindings', () => {
  it.each(['MouseBack', 'MouseForward'])('accepts %s with optional modifiers', (key) => {
    for (const prefix of ['', 'Shift+', 'Alt+', 'Mod+Shift+']) {
      expect(normalizeKeybinding(`${prefix}${key.toLowerCase()}`)).toEqual({
        ok: true,
        value: `${prefix}${key}`
      })
    }
  })

  it.each(['darwin', 'linux', 'win32'] as const)(
    'captures and matches modifiers on %s',
    (platform) => {
      const input = {
        key: 'MouseBack',
        metaKey: platform === 'darwin',
        ctrlKey: platform !== 'darwin',
        shiftKey: true
      }
      expect(keybindingFromInputForAction('tab.previousTerminal', input, platform)).toEqual({
        ok: true,
        value: 'Mod+Shift+MouseBack'
      })
      expect(keybindingMatchesInput('Mod+Shift+MouseBack', input, platform)).toBe(true)
      expect(keybindingMatchesInput('MouseBack', input, platform)).toBe(false)
      expect(keybindingMatchesInput('Mod+Shift+MouseForward', input, platform)).toBe(false)
      expect(formatKeybinding('Mod+MouseBack', platform)).toEqual([
        platform === 'darwin' ? '⌘' : 'Ctrl',
        'Mouse Back'
      ])
    }
  )

  it('finds mouse conflicts and retains digit-index validation', () => {
    expect(
      findKeybindingConflicts('linux', {
        'tab.nextTerminal': ['MouseForward'],
        'tab.previousTerminal': ['MouseForward']
      })
    ).toEqual([
      {
        binding: 'MouseForward',
        actionIds: expect.arrayContaining(['tab.nextTerminal', 'tab.previousTerminal'])
      }
    ])
    expect(normalizeKeybindingArrayForAction('tab.selectByIndex', ['MouseBack'])).toMatchObject({
      ok: false
    })
    expect(normalizeKeybinding('MouseMiddle')).toMatchObject({ ok: false })
    expect(normalizeKeybinding('A')).toMatchObject({ ok: false })
  })
})

describe('mouse binding storage split', () => {
  it('classifies bindings by their key, modifiers aside', () => {
    expect(isMouseBinding('Mod+Shift+MouseForward')).toBe(true)
    expect(isMouseBinding('mouseback')).toBe(true)
    expect(isMouseBinding('Mod+Shift+P')).toBe(false)
    expect(isMouseBinding('MouseMiddle')).toBe(false)
  })

  it('splits a list into keyboard and mouse parts and rejoins it keyboard first', () => {
    expect(splitBindingsByInputKind(['MouseBack', 'Mod+Shift+P', 'Shift+MouseForward'])).toEqual({
      keyboard: ['Mod+Shift+P'],
      mouse: ['MouseBack', 'Shift+MouseForward']
    })

    const split = splitOverridesByInputKind({
      'worktree.palette': ['Mod+Shift+P', 'MouseBack'],
      'worktree.quickOpen': ['Mod+Shift+O']
    })
    expect(split).toEqual({
      keyboard: {
        'worktree.palette': ['Mod+Shift+P'],
        'worktree.quickOpen': ['Mod+Shift+O']
      },
      mouse: { 'worktree.palette': ['MouseBack'] }
    })
    expect(unionKeybindingOverrides(split.keyboard, split.mouse)).toEqual({
      'worktree.palette': ['Mod+Shift+P', 'MouseBack'],
      'worktree.quickOpen': ['Mod+Shift+O']
    })
  })

  it('rejoins a mouse-only action and leaves absent platform sections absent', () => {
    expect(
      unionKeybindingOverrides({ 'worktree.palette': [] }, { 'worktree.palette': ['MouseBack'] })
    ).toEqual({ 'worktree.palette': ['MouseBack'] })

    expect(
      unionPlatformKeybindingOverrides(
        { darwin: { 'worktree.palette': ['Mod+Shift+P'] } },
        { linux: { 'worktree.palette': ['MouseBack'] } }
      )
    ).toEqual({
      darwin: { 'worktree.palette': ['Mod+Shift+P'] },
      linux: { 'worktree.palette': ['MouseBack'] }
    })
  })

  it('keeps the parseable entries of a stored list instead of dropping the action', () => {
    expect(
      normalizeStoredKeybindingArrayForAction('worktree.palette', [
        'mod+shift+p',
        'MouseMiddle',
        'mouseback'
      ])
    ).toEqual({
      bindings: ['Mod+Shift+P', 'MouseBack'],
      rejected: [{ binding: 'MouseMiddle', error: 'Use a shortcut like Ctrl+Shift+P or Cmd+K.' }]
    })
  })
})
