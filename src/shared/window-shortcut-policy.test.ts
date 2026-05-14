/* eslint-disable max-lines -- Why: this file covers every branch of the
shortcut policy (letter chords, zoom variants, alt/shift gating, history
navigation, new-workspace tab routing). Splitting across files would
fragment the test of a single pure function. */
import { describe, expect, it } from 'vitest'
import {
  isWindowShortcutModifierChord,
  resolveWindowShortcutAction,
  type WindowShortcutAction,
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
      { code: 'KeyJ', key: 'j', meta: false, control: true, alt: false, shift: false }
    ]

    for (const input of nonMacCases) {
      expect(resolveWindowShortcutAction(input, 'linux')).toBeNull()
    }

    expect(
      resolveWindowShortcutAction(
        { code: 'KeyE', key: 'e', meta: false, control: true, alt: false, shift: false },
        'linux'
      )
    ).toEqual({ type: 'dictationKeyDown' })
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

  it('resolves dictation using the layout-aware key value', () => {
    expect(
      resolveWindowShortcutAction(
        { code: 'KeyD', key: 'e', meta: true, control: false, alt: false, shift: false },
        'darwin'
      )
    ).toEqual({ type: 'dictationKeyDown' })

    expect(
      resolveWindowShortcutAction(
        { code: 'KeyE', key: 'd', meta: true, control: false, alt: false, shift: false },
        'darwin'
      )
    ).toBeNull()
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

  it('resolves the floating terminal chord despite carrying Alt', () => {
    expect(
      resolveWindowShortcutAction(
        {
          code: 'KeyT',
          key: 't',
          meta: true,
          control: false,
          alt: true,
          shift: false
        },
        'darwin'
      )
    ).toEqual({ type: 'toggleFloatingTerminal' })

    expect(
      resolveWindowShortcutAction(
        {
          code: 'KeyT',
          key: 't',
          meta: false,
          control: true,
          alt: true,
          shift: false
        },
        'linux'
      )
    ).toEqual({ type: 'toggleFloatingTerminal' })
  })

  it('rejects floating terminal chord variants with Shift or opposite primary modifier', () => {
    expect(
      resolveWindowShortcutAction(
        {
          code: 'KeyT',
          key: 't',
          meta: true,
          control: false,
          alt: true,
          shift: true
        },
        'darwin'
      )
    ).toBeNull()

    expect(
      resolveWindowShortcutAction(
        {
          code: 'KeyT',
          key: 't',
          meta: true,
          control: true,
          alt: true,
          shift: false
        },
        'linux'
      )
    ).toBeNull()
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
    // result. A future addition that intentionally consumes e.g. Cmd+Alt+KeyY
    // must add a new branch explicitly.
    expect(
      resolveWindowShortcutAction(
        {
          code: 'KeyY',
          key: 'y',
          meta: true,
          control: false,
          alt: true,
          shift: false
        },
        'darwin'
      )
    ).toBeNull()
  })

  it('routes Cmd/Ctrl+Shift+N to the unified new-workspace composer', () => {
    // Why: keep the former Create-from shortcut accepted so muscle memory
    // still opens the composer; source switching now lives in the smart name field.
    expect(
      resolveWindowShortcutAction(
        { code: 'KeyN', key: 'n', meta: true, control: false, alt: false, shift: true },
        'darwin'
      )
    ).toEqual({ type: 'openNewWorkspace' })

    expect(
      resolveWindowShortcutAction(
        { code: 'KeyN', key: 'n', meta: false, control: true, alt: false, shift: true },
        'linux'
      )
    ).toEqual({ type: 'openNewWorkspace' })

    // Alt must still be rejected — the allowlist is alt-free for Cmd/Ctrl+N
    // so future chords like Cmd+Alt+Shift+N remain available.
    expect(
      resolveWindowShortcutAction(
        { code: 'KeyN', key: 'n', meta: true, control: false, alt: true, shift: true },
        'darwin'
      )
    ).toBeNull()
  })

  it('resolves letter shortcuts by layout-aware key, with code as fallback', () => {
    // Why: non-QWERTY layouts (Dvorak, Colemak, AZERTY, …) move letters to
    // other physical keys. Matching only on `input.code` (always QWERTY)
    // breaks the shortcut for those users. Prefer `input.key` when it is a
    // letter; fall back to `input.code` only when `key` is empty or a
    // non-letter marker (dead keys, IME edge cases).

    // Dvorak layout: the letters the user presses sit on different codes
    // ('b'→KeyN, 'l'→KeyP, 'p'→KeyR, 'n'→KeyL, 'j'→KeyC). All must resolve
    // to the layout-matched shortcut.
    const dvorak: [WindowShortcutInput, WindowShortcutAction][] = [
      [
        { code: 'KeyN', key: 'b', meta: true, alt: false, shift: false },
        { type: 'toggleLeftSidebar' }
      ],
      [
        { code: 'KeyP', key: 'l', meta: true, alt: false, shift: false },
        { type: 'toggleRightSidebar' }
      ],
      [{ code: 'KeyR', key: 'p', meta: true, alt: false, shift: false }, { type: 'openQuickOpen' }],
      [
        { code: 'KeyL', key: 'n', meta: true, alt: false, shift: false },
        { type: 'openNewWorkspace' }
      ],
      [
        { code: 'KeyC', key: 'j', meta: true, alt: false, shift: false },
        { type: 'toggleWorktreePalette' }
      ]
    ]
    for (const [input, expected] of dvorak) {
      expect(resolveWindowShortcutAction(input, 'darwin')).toEqual(expected)
    }

    // Inverse guard: physical QWERTY-B on Dvorak types 'x' — that is the
    // platform Cut shortcut, not the sidebar. The layout-aware match must
    // reject it.
    expect(
      resolveWindowShortcutAction(
        { code: 'KeyB', key: 'x', meta: true, alt: false, shift: false },
        'darwin'
      )
    ).toBeNull()

    // Fallback: drivers/IME states that leave `key` empty or non-letter
    // (dead keys, modifier names) must still reach the shortcut on QWERTY.
    const fallbacks: [WindowShortcutInput, WindowShortcutAction][] = [
      [
        { code: 'KeyB', key: '', meta: true, alt: false, shift: false },
        { type: 'toggleLeftSidebar' }
      ],
      [
        { code: 'KeyN', key: 'Dead', meta: true, alt: false, shift: false },
        { type: 'openNewWorkspace' }
      ],
      [{ code: 'KeyP', meta: true, alt: false, shift: false }, { type: 'openQuickOpen' }]
    ]
    for (const [input, expected] of fallbacks) {
      expect(resolveWindowShortcutAction(input, 'darwin')).toEqual(expected)
    }
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
