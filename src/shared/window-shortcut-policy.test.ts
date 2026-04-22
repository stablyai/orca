import { describe, expect, it } from 'vitest'
import {
  isWindowShortcutModifierChord,
  resolveWindowShortcutAction,
  type WindowShortcutInput
} from './window-shortcut-policy'

describe('resolveWindowShortcutAction', () => {
  it('keeps ctrl/cmd+r and readline control chords out of the main-process allowlist', () => {
    const macCases: WindowShortcutInput[] = [
      { code: 'KeyR', key: 'r', meta: true, control: false, alt: false, shift: false },
      { code: 'KeyR', key: 'r', meta: false, control: true, alt: false, shift: false },
      { code: 'KeyU', key: 'u', meta: false, control: true, alt: false, shift: false },
      { code: 'KeyE', key: 'e', meta: false, control: true, alt: false, shift: false }
    ]

    for (const input of macCases) {
      expect(resolveWindowShortcutAction(input, 'darwin')).toBeNull()
    }

    const nonMacCases: WindowShortcutInput[] = [
      { code: 'KeyR', key: 'r', meta: false, control: true, alt: false, shift: false },
      { code: 'KeyU', key: 'u', meta: false, control: true, alt: false, shift: false },
      { code: 'KeyE', key: 'e', meta: false, control: true, alt: false, shift: false },
      { code: 'KeyJ', key: 'j', meta: false, control: true, alt: false, shift: false }
    ]

    for (const input of nonMacCases) {
      expect(resolveWindowShortcutAction(input, 'linux')).toBeNull()
    }
  })

  it('resolves the explicit window shortcut allowlist on macOS', () => {
    expect(
      resolveWindowShortcutAction(
        { code: 'KeyJ', key: 'j', meta: true, control: false, alt: false, shift: false },
        'darwin'
      )
    ).toEqual({ type: 'toggleWorktreePalette' })

    expect(
      resolveWindowShortcutAction(
        { code: 'KeyP', key: 'p', meta: true, control: false, alt: false, shift: false },
        'darwin'
      )
    ).toEqual({ type: 'openQuickOpen' })

    expect(
      resolveWindowShortcutAction(
        { code: 'Digit3', key: '3', meta: true, control: false, alt: false, shift: false },
        'darwin'
      )
    ).toEqual({ type: 'jumpToWorktreeIndex', index: 2 })
  })

  it('requires shift for the non-mac worktree palette shortcut', () => {
    expect(
      resolveWindowShortcutAction(
        { code: 'KeyJ', key: 'j', meta: false, control: true, alt: false, shift: false },
        'win32'
      )
    ).toBeNull()

    expect(
      resolveWindowShortcutAction(
        { code: 'KeyJ', key: 'j', meta: false, control: true, alt: false, shift: true },
        'win32'
      )
    ).toEqual({ type: 'toggleWorktreePalette' })
  })

  it('accepts all supported zoom key variants', () => {
    const zoomInCases: WindowShortcutInput[] = [
      { key: '=', meta: true, control: false, alt: false, shift: false },
      { key: '+', meta: true, control: false, alt: false, shift: true },
      { code: 'NumpadAdd', key: '', meta: true, control: false, alt: false, shift: false }
    ]
    for (const input of zoomInCases) {
      expect(resolveWindowShortcutAction(input, 'darwin')).toEqual({
        type: 'zoom',
        direction: 'in'
      })
    }

    const zoomOutCases: WindowShortcutInput[] = [
      { key: '-', meta: false, control: true, alt: false, shift: false },
      { key: '_', meta: false, control: true, alt: false, shift: true },
      { key: 'Minus', meta: false, control: true, alt: false, shift: false },
      { code: 'NumpadSubtract', key: '', meta: false, control: true, alt: false, shift: false }
    ]
    for (const input of zoomOutCases) {
      expect(resolveWindowShortcutAction(input, 'linux')).toEqual({
        type: 'zoom',
        direction: 'out'
      })
    }

    expect(
      resolveWindowShortcutAction(
        { key: '0', meta: false, control: true, alt: false, shift: false },
        'linux'
      )
    ).toEqual({ type: 'zoom', direction: 'reset' })
  })

  it('resolves the worktree-history chord despite carrying Alt', () => {
    expect(
      resolveWindowShortcutAction(
        {
          code: 'ArrowLeft',
          key: 'ArrowLeft',
          meta: true,
          control: false,
          alt: true,
          shift: false
        },
        'darwin'
      )
    ).toEqual({ type: 'worktreeHistoryNavigate', direction: 'back' })

    expect(
      resolveWindowShortcutAction(
        {
          code: 'ArrowRight',
          key: 'ArrowRight',
          meta: true,
          control: false,
          alt: true,
          shift: false
        },
        'darwin'
      )
    ).toEqual({ type: 'worktreeHistoryNavigate', direction: 'forward' })

    expect(
      resolveWindowShortcutAction(
        {
          code: 'ArrowLeft',
          key: 'ArrowLeft',
          meta: false,
          control: true,
          alt: true,
          shift: false
        },
        'linux'
      )
    ).toEqual({ type: 'worktreeHistoryNavigate', direction: 'back' })
  })

  it('rejects the history chord when Shift is also held', () => {
    expect(
      resolveWindowShortcutAction(
        {
          code: 'ArrowLeft',
          key: 'ArrowLeft',
          meta: true,
          control: false,
          alt: true,
          shift: true
        },
        'darwin'
      )
    ).toBeNull()
  })

  it('leaves Alt+Arrow without a primary modifier untouched (word-nav territory)', () => {
    expect(
      resolveWindowShortcutAction(
        {
          code: 'ArrowLeft',
          key: 'ArrowLeft',
          meta: false,
          control: false,
          alt: true,
          shift: false
        },
        'darwin'
      )
    ).toBeNull()
  })

  it('ignores Cmd/Ctrl+Alt combined with ArrowUp or ArrowDown', () => {
    // Why: the history predicate explicitly narrows to ArrowLeft/ArrowRight.
    // Cmd+Alt+Up / Cmd+Alt+Down must fall through to null so the event
    // reaches the renderer/PTTY (e.g. shells / readline).
    expect(
      resolveWindowShortcutAction(
        {
          code: 'ArrowUp',
          key: 'ArrowUp',
          meta: true,
          control: false,
          alt: true,
          shift: false
        },
        'darwin'
      )
    ).toBeNull()

    expect(
      resolveWindowShortcutAction(
        {
          code: 'ArrowDown',
          key: 'ArrowDown',
          meta: false,
          control: true,
          alt: true,
          shift: false
        },
        'linux'
      )
    ).toBeNull()
  })

  it('rejects the history chord when the opposite primary modifier is also held', () => {
    // Why: Cmd+Ctrl+Alt+Arrow on macOS collides with Mission Control space
    // switching; Ctrl+Meta+Alt+Arrow on Linux collides with GNOME workspace
    // switching. The app must not intercept either.
    expect(
      resolveWindowShortcutAction(
        {
          code: 'ArrowLeft',
          key: 'ArrowLeft',
          meta: true,
          control: true,
          alt: true,
          shift: false
        },
        'darwin'
      )
    ).toBeNull()

    expect(
      resolveWindowShortcutAction(
        {
          code: 'ArrowRight',
          key: 'ArrowRight',
          meta: true,
          control: true,
          alt: true,
          shift: false
        },
        'linux'
      )
    ).toBeNull()
  })

  it('still returns null for other Cmd/Ctrl+Alt combos (not an allowlist escape)', () => {
    // Why: regression guard — the history early-return must not swallow
    // unrelated primary+alt chords in a way that changes their old null
    // result. A future addition that intentionally consumes e.g. Cmd+Alt+KeyT
    // must add a new branch explicitly.
    expect(
      resolveWindowShortcutAction(
        {
          code: 'KeyB',
          key: 'b',
          meta: true,
          control: false,
          alt: true,
          shift: false
        },
        'darwin'
      )
    ).toBeNull()
  })

  it('exposes the shared platform modifier gate used by browser guests', () => {
    expect(
      isWindowShortcutModifierChord({ meta: true, control: false, alt: false }, 'darwin')
    ).toBe(true)
    expect(isWindowShortcutModifierChord({ meta: false, control: true, alt: false }, 'linux')).toBe(
      true
    )
    expect(isWindowShortcutModifierChord({ meta: false, control: true, alt: true }, 'linux')).toBe(
      false
    )
  })
})
