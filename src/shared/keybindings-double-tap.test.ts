// Double-tap modifier gestures: parsing, matching, capture, format, conflicts.
import { describe, expect, it } from 'vitest'
import {
  findKeybindingConflicts,
  formatKeybinding,
  formatKeybindingList,
  isDoubleTapBinding,
  keybindingFromInput,
  keybindingMatchesAction,
  keybindingMatchesInput,
  normalizeKeybinding
} from './keybindings'

describe('keybindings', () => {
  it('parses, normalizes, and rejects double-tap modifier bindings', () => {
    expect(normalizeKeybinding('DoubleTap+Shift')).toEqual({ ok: true, value: 'DoubleTap+Shift' })
    expect(normalizeKeybinding(' doubletap + shift ')).toEqual({
      ok: true,
      value: 'DoubleTap+Shift'
    })
    expect(normalizeKeybinding('DoubleTap+Mod')).toEqual({ ok: true, value: 'DoubleTap+Mod' })
    expect(normalizeKeybinding('DoubleTap+Cmd')).toEqual({ ok: true, value: 'DoubleTap+Cmd' })
    expect(normalizeKeybinding('DoubleTap+Alt')).toEqual({ ok: true, value: 'DoubleTap+Alt' })
    expect(normalizeKeybinding('DoubleTap+Ctrl')).toEqual({ ok: true, value: 'DoubleTap+Ctrl' })

    // A key after DoubleTap is invalid.
    expect(normalizeKeybinding('DoubleTap+Shift+P')).toMatchObject({ ok: false })
    // Two modifiers is invalid.
    expect(normalizeKeybinding('DoubleTap+Shift+Alt')).toMatchObject({ ok: false })
    // Mod + platform-specific reuses the shared error.
    expect(normalizeKeybinding('DoubleTap+Mod+Cmd')).toEqual({
      ok: false,
      error: 'Use either Mod or a platform-specific modifier, not both.'
    })
    // Bare DoubleTap is invalid.
    expect(normalizeKeybinding('DoubleTap')).toMatchObject({ ok: false })

    expect(isDoubleTapBinding('DoubleTap+Shift')).toBe(true)
    expect(isDoubleTapBinding('Mod+P')).toBe(false)
    expect(isDoubleTapBinding('not-a-binding')).toBe(false)
  })

  it('matches double-tap bindings only against synthetic double-tap input', () => {
    expect(
      keybindingMatchesInput('DoubleTap+Shift', { doubleTapModifier: 'Shift' }, 'darwin')
    ).toBe(true)
    // Mod resolves per platform: meta on macOS, control elsewhere.
    expect(keybindingMatchesInput('DoubleTap+Mod', { doubleTapModifier: 'Cmd' }, 'darwin')).toBe(
      true
    )
    expect(keybindingMatchesInput('DoubleTap+Mod', { doubleTapModifier: 'Ctrl' }, 'win32')).toBe(
      true
    )
    expect(keybindingMatchesInput('DoubleTap+Mod', { doubleTapModifier: 'Cmd' }, 'win32')).toBe(
      false
    )
    expect(keybindingMatchesInput('DoubleTap+Mod', { doubleTapModifier: 'Ctrl' }, 'darwin')).toBe(
      false
    )
    expect(keybindingMatchesInput('DoubleTap+Shift', { doubleTapModifier: 'Alt' }, 'darwin')).toBe(
      false
    )

    // Cross-type negatives: a double-tap binding never matches a normal keydown,
    // and a normal binding never matches a synthetic double-tap input.
    expect(
      keybindingMatchesInput('DoubleTap+Shift', { key: 'A', code: 'KeyA', shift: true }, 'darwin')
    ).toBe(false)
    expect(keybindingMatchesInput('Mod+P', { doubleTapModifier: 'Cmd' }, 'darwin')).toBe(false)

    // Action-level matching works through user overrides, for free.
    expect(
      keybindingMatchesAction('worktree.quickOpen', { doubleTapModifier: 'Shift' }, 'darwin', {
        'worktree.quickOpen': ['DoubleTap+Shift']
      })
    ).toBe(true)
    expect(
      keybindingMatchesAction('worktree.quickOpen', { doubleTapModifier: 'Alt' }, 'darwin', {
        'worktree.quickOpen': ['DoubleTap+Shift']
      })
    ).toBe(false)
  })

  it('captures double-tap gestures into canonical bindings', () => {
    expect(keybindingFromInput({ doubleTapModifier: 'Shift' }, 'darwin')).toEqual({
      ok: true,
      value: 'DoubleTap+Shift'
    })
    // The platform primary modifier canonicalizes to Mod, matching normal capture.
    expect(keybindingFromInput({ doubleTapModifier: 'Cmd' }, 'darwin')).toEqual({
      ok: true,
      value: 'DoubleTap+Mod'
    })
    expect(keybindingFromInput({ doubleTapModifier: 'Ctrl' }, 'win32')).toEqual({
      ok: true,
      value: 'DoubleTap+Mod'
    })
    // A non-primary modifier keeps its explicit token.
    expect(keybindingFromInput({ doubleTapModifier: 'Ctrl' }, 'darwin')).toEqual({
      ok: true,
      value: 'DoubleTap+Ctrl'
    })
    expect(keybindingFromInput({ doubleTapModifier: 'Alt' }, 'linux')).toEqual({
      ok: true,
      value: 'DoubleTap+Alt'
    })
    // Ctrl is the primary modifier on Linux too, so it canonicalizes to Mod.
    expect(keybindingFromInput({ doubleTapModifier: 'Ctrl' }, 'linux')).toEqual({
      ok: true,
      value: 'DoubleTap+Mod'
    })
    // Cmd is not the primary modifier off-mac, so it stays explicit.
    expect(keybindingFromInput({ doubleTapModifier: 'Cmd' }, 'linux')).toEqual({
      ok: true,
      value: 'DoubleTap+Cmd'
    })
  })

  it('formats double-tap bindings as the modifier glyph twice', () => {
    expect(formatKeybinding('DoubleTap+Shift', 'darwin')).toEqual(['⇧', '⇧'])
    expect(formatKeybinding('DoubleTap+Shift', 'linux')).toEqual(['Shift', 'Shift'])
    expect(formatKeybinding('DoubleTap+Mod', 'darwin')).toEqual(['⌘', '⌘'])
    expect(formatKeybinding('DoubleTap+Mod', 'win32')).toEqual(['Ctrl', 'Ctrl'])
    expect(formatKeybinding('DoubleTap+Cmd', 'win32')).toEqual(['Cmd', 'Cmd'])
    expect(formatKeybinding('DoubleTap+Alt', 'darwin')).toEqual(['⌥', '⌥'])
    // Ctrl's glyph ⌃ diverges from Mod's ⌘ on Mac, so cover it explicitly.
    expect(formatKeybinding('DoubleTap+Ctrl', 'darwin')).toEqual(['⌃', '⌃'])
    expect(formatKeybindingList(['DoubleTap+Shift'], 'darwin')).toBe('⇧ ⇧')
    expect(formatKeybindingList(['DoubleTap+Shift'], 'linux')).toBe('Shift Shift')
  })

  it('reports conflicts across two double-tap bindings', () => {
    // Both actions share the same DoubleTap+Shift binding via overrides, so both
    // are in customizedActions and the conflict detector must flag them.
    const conflicts = findKeybindingConflicts('darwin', {
      'worktree.quickOpen': ['DoubleTap+Shift'],
      'view.tasks': ['DoubleTap+Shift']
    })
    expect(conflicts).toContainEqual({
      binding: 'DoubleTap+Shift',
      actionIds: expect.arrayContaining(['worktree.quickOpen', 'view.tasks'])
    })
  })

  it('reports conflicts across platform-primary double-tap aliases', () => {
    expect(
      findKeybindingConflicts('darwin', {
        'worktree.quickOpen': ['DoubleTap+Mod'],
        'view.tasks': ['DoubleTap+Cmd']
      })
    ).toContainEqual({
      binding: 'DoubleTap+Mod',
      actionIds: expect.arrayContaining(['worktree.quickOpen', 'view.tasks'])
    })

    expect(
      findKeybindingConflicts('linux', {
        'worktree.quickOpen': ['DoubleTap+Mod'],
        'view.tasks': ['DoubleTap+Ctrl']
      })
    ).toContainEqual({
      binding: 'DoubleTap+Mod',
      actionIds: expect.arrayContaining(['worktree.quickOpen', 'view.tasks'])
    })
  })

  it('does not report a conflict when one action lists double-tap aliases for itself', () => {
    expect(
      findKeybindingConflicts('darwin', {
        'worktree.quickOpen': ['DoubleTap+Mod', 'DoubleTap+Cmd']
      })
    ).toEqual([])
    expect(
      findKeybindingConflicts('linux', {
        'worktree.quickOpen': ['DoubleTap+Mod', 'DoubleTap+Ctrl']
      })
    ).toEqual([])
  })
})
