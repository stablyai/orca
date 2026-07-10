import { describe, expect, it } from 'vitest'
import {
  isRecentTabSwitcherCommitRelease,
  isWindowShortcutModifierChord,
  matchesRecentTabSwitcherChord,
  resolveWindowShortcutAction,
  type WindowShortcutAction,
  type WindowShortcutInput
} from './window-shortcut-policy'
import type { KeybindingOverrides } from './keybindings'

describe('resolveWindowShortcutAction', () => {
  it('keeps ctrl/cmd+r and unrelated readline control chords out of the allowlist', () => {
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
        { code: 'Comma', key: ',', meta: true, control: false, alt: false, shift: false },
        'darwin'
      )
    ).toEqual({ type: 'openSettings' })

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

    expect(
      resolveWindowShortcutAction(
        { code: 'Digit3', key: '3', meta: false, control: true, alt: false, shift: false },
        'darwin'
      )
    ).toEqual({ type: 'jumpToTabIndex', index: 2 })
  })

  it('uses Alt+number for tab jumps on Windows/Linux without stealing workspace jumps', () => {
    expect(
      resolveWindowShortcutAction(
        { code: 'Digit4', key: '4', meta: false, control: true, alt: false, shift: false },
        'linux'
      )
    ).toEqual({ type: 'jumpToWorktreeIndex', index: 3 })

    expect(
      resolveWindowShortcutAction(
        { code: 'Digit4', key: '4', meta: false, control: false, alt: true, shift: false },
        'linux'
      )
    ).toEqual({ type: 'jumpToTabIndex', index: 3 })

    expect(
      resolveWindowShortcutAction(
        { code: 'Digit4', key: '4', meta: false, control: false, alt: true, shift: true },
        'win32'
      )
    ).toBeNull()
  })

  it('resolves customized quick-command menu shortcuts with terminal policy gating', () => {
    const input: WindowShortcutInput = {
      code: 'KeyQ',
      key: 'q',
      meta: false,
      control: true,
      alt: false,
      shift: true
    }
    const overrides: KeybindingOverrides = {
      'tab.openQuickCommandsMenu': ['Mod+Shift+Q']
    }

    expect(resolveWindowShortcutAction(input, 'linux', overrides)).toEqual({
      type: 'toggleQuickCommandsMenu'
    })
    expect(
      resolveWindowShortcutAction(input, 'linux', overrides, {
        context: 'terminal',
        terminalShortcutPolicy: 'terminal-first'
      })
    ).toBeNull()
    expect(
      resolveWindowShortcutAction(input, 'linux', overrides, {
        context: 'terminal',
        terminalShortcutPolicy: 'orca-first'
      })
    ).toEqual({ type: 'toggleQuickCommandsMenu' })
  })

  it('keeps digit-index navigation ahead of customized quick-command shortcuts', () => {
    expect(
      resolveWindowShortcutAction(
        { code: 'Digit3', key: '3', meta: true, control: false, alt: false, shift: false },
        'darwin',
        { 'tab.openQuickCommandsMenu': ['Mod+3'] }
      )
    ).toEqual({ type: 'jumpToWorktreeIndex', index: 2 })

    expect(
      resolveWindowShortcutAction(
        { code: 'Digit4', key: '4', meta: false, control: false, alt: true, shift: false },
        'linux',
        { 'tab.openQuickCommandsMenu': ['Alt+4'] }
      )
    ).toEqual({ type: 'jumpToTabIndex', index: 3 })
  })

  it('honors remapped tab/workspace number ranges, including swapping the modifiers', () => {
    // Swap on macOS: tab now uses Cmd+1-9, workspace uses Ctrl+1-9.
    const swapped: KeybindingOverrides = {
      'tab.selectByIndex': ['Mod+1'],
      'workspace.selectByIndex': ['Ctrl+1']
    }
    expect(
      resolveWindowShortcutAction(
        { code: 'Digit3', key: '3', meta: true, control: false, alt: false, shift: false },
        'darwin',
        swapped
      )
    ).toEqual({ type: 'jumpToTabIndex', index: 2 })
    expect(
      resolveWindowShortcutAction(
        { code: 'Digit3', key: '3', meta: false, control: true, alt: false, shift: false },
        'darwin',
        swapped
      )
    ).toEqual({ type: 'jumpToWorktreeIndex', index: 2 })

    // A custom chord with an extra modifier also resolves.
    expect(
      resolveWindowShortcutAction(
        { code: 'Digit2', key: '2', meta: false, control: true, alt: false, shift: true },
        'linux',
        { 'tab.selectByIndex': ['Mod+Shift+1'] }
      )
    ).toEqual({ type: 'jumpToTabIndex', index: 1 })

    // Disabling the range leaves the chord unclaimed.
    expect(
      resolveWindowShortcutAction(
        { code: 'Digit3', key: '3', meta: false, control: true, alt: false, shift: false },
        'linux',
        { 'workspace.selectByIndex': [] }
      )
    ).toBeNull()

    // Both ranges disabled: neither the workspace nor the tab digit chord resolves.
    const bothDisabled: KeybindingOverrides = {
      'workspace.selectByIndex': [],
      'tab.selectByIndex': []
    }
    expect(
      resolveWindowShortcutAction(
        { code: 'Digit3', key: '3', meta: true, control: false, alt: false, shift: false },
        'darwin',
        bothDisabled
      )
    ).toBeNull()
    expect(
      resolveWindowShortcutAction(
        { code: 'Digit3', key: '3', meta: false, control: true, alt: false, shift: false },
        'darwin',
        bothDisabled
      )
    ).toBeNull()
  })

  it('keeps Orca-first active in terminal context but lets Terminal-first pass risky app chords', () => {
    const macWorktreePalette = {
      code: 'KeyJ',
      key: 'j',
      meta: true,
      control: false,
      alt: false,
      shift: false
    }
    expect(
      resolveWindowShortcutAction(macWorktreePalette, 'darwin', undefined, {
        context: 'terminal',
        terminalShortcutPolicy: 'orca-first'
      })
    ).toEqual({ type: 'toggleWorktreePalette' })
    expect(
      resolveWindowShortcutAction(macWorktreePalette, 'darwin', undefined, {
        context: 'terminal',
        terminalShortcutPolicy: 'terminal-first'
      })
    ).toBeNull()

    expect(
      resolveWindowShortcutAction(
        { code: 'Digit3', key: '3', meta: true, control: false, alt: false, shift: false },
        'darwin',
        undefined,
        { context: 'terminal', terminalShortcutPolicy: 'terminal-first' }
      )
    ).toBeNull()
    expect(
      resolveWindowShortcutAction(
        { code: 'Tab', key: 'Tab', meta: false, control: true, alt: false, shift: false },
        'linux',
        undefined,
        { context: 'terminal', terminalShortcutPolicy: 'terminal-first' }
      )
    ).toEqual({ type: 'switchRecentTab' })
    expect(
      resolveWindowShortcutAction(
        { code: 'Digit3', key: '3', meta: false, control: true, alt: false, shift: false },
        'darwin',
        undefined,
        { context: 'terminal', terminalShortcutPolicy: 'terminal-first' }
      )
    ).toBeNull()
    expect(
      resolveWindowShortcutAction(
        { code: 'Digit3', key: '3', meta: false, control: true, alt: false, shift: false },
        'darwin',
        undefined,
        { context: 'terminal', terminalShortcutPolicy: 'orca-first' }
      )
    ).toEqual({ type: 'jumpToTabIndex', index: 2 })
  })

  it('does not resolve the removed PDF export shortcut globally', () => {
    expect(
      resolveWindowShortcutAction(
        { code: 'KeyE', key: 'e', meta: true, control: false, alt: false, shift: true },
        'darwin'
      )
    ).toBeNull()
  })

  it('routes menu-backed actions through the same window shortcut policy', () => {
    expect(
      resolveWindowShortcutAction(
        { code: 'KeyR', key: 'r', meta: false, control: true, alt: false, shift: true },
        'linux'
      )
    ).toEqual({ type: 'forceReload' })
    expect(
      resolveWindowShortcutAction(
        { code: 'KeyR', key: 'r', meta: false, control: true, alt: false, shift: true },
        'linux',
        undefined,
        { context: 'terminal', terminalShortcutPolicy: 'terminal-first' }
      )
    ).toBeNull()
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

  it('applies custom keybinding overrides to dictation and main-process shortcuts', () => {
    expect(
      resolveWindowShortcutAction(
        { code: 'KeyE', key: 'e', meta: false, control: true, alt: false, shift: false },
        'linux',
        { 'voice.dictation': [] }
      )
    ).toBeNull()

    expect(
      resolveWindowShortcutAction(
        { code: 'KeyY', key: 'y', meta: false, control: true, alt: false, shift: true },
        'linux',
        { 'voice.dictation': ['Mod+Shift+Y'] }
      )
    ).toEqual({ type: 'dictationKeyDown' })
  })

  it('applies custom keybinding overrides to main-process shortcuts', () => {
    const overrides: KeybindingOverrides = {
      'worktree.quickOpen': ['Mod+Shift+O'],
      'workspace.openBoard': ['Mod+Alt+B'],
      'view.tasks': ['Mod+Alt+K']
    }

    expect(
      resolveWindowShortcutAction(
        { code: 'KeyP', key: 'p', meta: false, control: true, alt: false, shift: false },
        'linux',
        overrides
      )
    ).toBeNull()
    expect(
      resolveWindowShortcutAction(
        { code: 'KeyO', key: 'o', meta: false, control: true, alt: false, shift: true },
        'linux',
        overrides
      )
    ).toEqual({ type: 'openQuickOpen' })
    expect(
      resolveWindowShortcutAction(
        { code: 'KeyB', key: 'b', meta: false, control: true, alt: true, shift: false },
        'linux',
        overrides
      )
    ).toEqual({ type: 'openWorkspaceBoard' })
    expect(
      resolveWindowShortcutAction(
        { code: 'KeyK', key: 'k', meta: false, control: true, alt: true, shift: false },
        'linux',
        overrides
      )
    ).toEqual({ type: 'openTasks' })
  })

  it('leaves workspace delete unbound by default but honors custom terminal-active bindings', () => {
    const input = {
      code: 'Backspace',
      key: 'Backspace',
      meta: false,
      control: true,
      alt: false,
      shift: true
    }

    expect(resolveWindowShortcutAction(input, 'linux')).toBeNull()
    expect(
      resolveWindowShortcutAction(input, 'linux', {
        'workspace.delete': ['Mod+Shift+Backspace']
      })
    ).toEqual({ type: 'deleteCurrentWorkspace' })
    expect(
      resolveWindowShortcutAction(
        input,
        'linux',
        { 'workspace.delete': ['Mod+Shift+Backspace'] },
        { context: 'terminal', terminalShortcutPolicy: 'terminal-first' }
      )
    ).toEqual({ type: 'deleteCurrentWorkspace' })
  })

  it('resolves the MRU tab quick-toggle chord', () => {
    expect(
      resolveWindowShortcutAction(
        { code: 'Tab', key: 'Tab', meta: false, control: true, alt: false, shift: false },
        'linux'
      )
    ).toEqual({ type: 'switchRecentTab' })
  })

  it('gates the held Ctrl+Tab switcher on the configurable binding', () => {
    const input = { code: 'Tab', key: 'Tab', meta: false, control: true, alt: false, shift: true }
    const domInput = {
      code: 'Tab',
      key: 'Tab',
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: true
    }

    expect(matchesRecentTabSwitcherChord(input, 'linux')).toBe(true)
    expect(matchesRecentTabSwitcherChord(domInput, 'linux')).toBe(true)
    expect(matchesRecentTabSwitcherChord(input, 'linux', { 'tab.previousRecent': [] })).toBe(false)
    expect(
      matchesRecentTabSwitcherChord(input, 'linux', { 'tab.previousRecent': ['Ctrl+Alt+Tab'] })
    ).toBe(false)
  })

  it('matches real DOM-style event fields without relying on enumerable properties', () => {
    const eventInput = {} as WindowShortcutInput
    Object.defineProperties(eventInput, {
      code: { value: 'Tab' },
      key: { value: 'Tab' },
      metaKey: { value: false },
      ctrlKey: { value: true },
      altKey: { value: false },
      shiftKey: { value: true }
    })

    expect(matchesRecentTabSwitcherChord(eventInput, 'linux')).toBe(true)
  })

  it('recognizes Ctrl+Tab commit releases across Electron surfaces', () => {
    expect(
      isRecentTabSwitcherCommitRelease({
        type: 'keyUp',
        code: 'ControlLeft',
        key: 'Control',
        control: false
      })
    ).toBe(true)
    expect(
      isRecentTabSwitcherCommitRelease({
        type: 'keyUp',
        code: 'Control',
        key: 'Control',
        control: false
      })
    ).toBe(true)
    expect(
      isRecentTabSwitcherCommitRelease({
        type: 'keyUp',
        code: 'Tab',
        key: 'Tab',
        control: false
      })
    ).toBe(true)
    expect(
      isRecentTabSwitcherCommitRelease({
        type: 'keyUp',
        code: 'Tab',
        key: 'Tab',
        control: true
      })
    ).toBe(false)
    expect(
      isRecentTabSwitcherCommitRelease({
        type: 'keyup',
        code: 'ControlLeft',
        key: 'Control',
        ctrlKey: false
      })
    ).toBe(true)
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
      { key: 'Minus', meta: false, control: true, alt: false, shift: false },
      { key: 'Subtract', meta: false, control: true, alt: false, shift: false },
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

    // Why: Ctrl+Shift+_ is PowerShell undo on Windows; zoom-out must not steal it.
    expect(
      resolveWindowShortcutAction(
        { key: '_', meta: false, control: true, alt: false, shift: true },
        'win32'
      )
    ).toBeNull()
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
          code: 'KeyA',
          key: 'a',
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
          code: 'KeyA',
          key: 'a',
          meta: false,
          control: true,
          alt: true,
          shift: false
        },
        'linux'
      )
    ).toEqual({ type: 'toggleFloatingTerminal' })
  })

  it('resolves the floating terminal chord when macOS Option composes the letter', () => {
    expect(
      resolveWindowShortcutAction(
        {
          code: 'KeyA',
          key: 'å',
          meta: true,
          control: false,
          alt: true,
          shift: false
        },
        'darwin'
      )
    ).toEqual({ type: 'toggleFloatingTerminal' })
  })

  it('rejects floating terminal chord variants with Shift or opposite primary modifier', () => {
    expect(
      resolveWindowShortcutAction(
        {
          code: 'KeyA',
          key: 'a',
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
          code: 'KeyA',
          key: 'a',
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

  it('resolves an allowlisted action from a synthetic double-tap input', () => {
    // (a) A synthetic DoubleTap+Shift input resolves the overridden action.
    const overrides: KeybindingOverrides = { 'worktree.quickOpen': ['DoubleTap+Shift'] }
    expect(
      resolveWindowShortcutAction({ doubleTapModifier: 'Shift' }, 'darwin', overrides)
    ).toEqual({ type: 'openQuickOpen' })

    // (b) A different modifier does not resolve it.
    expect(
      resolveWindowShortcutAction({ doubleTapModifier: 'Alt' }, 'darwin', overrides)
    ).toBeNull()

    // (c) Implicit numeric shortcuts are guarded on input.key, which a double-tap
    // input never has, so they cannot accidentally match a double-tap event.
    expect(resolveWindowShortcutAction({ doubleTapModifier: 'Cmd' }, 'darwin')).toBeNull()
  })
})
