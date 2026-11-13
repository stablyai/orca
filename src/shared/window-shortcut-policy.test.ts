import { describe, expect, it } from 'vitest'
import {
  isRecentTabSwitcherCommitRelease,
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

  it.each(['darwin', 'linux', 'win32'] as const)(
    'leaves Cmd/Ctrl+, to terminal apps on %s unless explicitly rebound',
    (platform) => {
      const input = {
        code: 'Comma',
        key: ',',
        meta: platform === 'darwin',
        control: platform !== 'darwin',
        alt: false,
        shift: false
      }
      expect(resolveWindowShortcutAction(input, platform)).toBeNull()
      expect(resolveWindowShortcutAction(input, platform, { 'tab.close': ['Mod+W'] })).toBeNull()
      expect(
        resolveWindowShortcutAction(input, platform, { 'app.settings': ['Mod+Comma'] })
      ).toEqual({ type: 'openSettings' })
    }
  )

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

    expect(
      resolveWindowShortcutAction(
        { code: 'Digit2', key: '2', meta: false, control: true, alt: false, shift: true },
        'linux',
        { 'tab.selectByIndex': ['Mod+Shift+1'] }
      )
    ).toEqual({ type: 'jumpToTabIndex', index: 1 })

    expect(
      resolveWindowShortcutAction(
        { code: 'Digit3', key: '3', meta: false, control: true, alt: false, shift: false },
        'linux',
        { 'workspace.selectByIndex': [] }
      )
    ).toBeNull()

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
      code: 'KeyK',
      key: 'k',
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

  it.each(['darwin', 'win32', 'linux'] as const)(
    'leaves sidebar deletion bindings to the focused surface on %s',
    (platform) => {
      const input = {
        code: 'Backspace',
        key: 'Backspace',
        meta: platform === 'darwin',
        control: platform !== 'darwin',
        alt: false,
        shift: true
      }

      expect(resolveWindowShortcutAction(input, platform)).toBeNull()
      const customInput = { ...input, code: 'KeyX', key: 'x', alt: true, shift: false }
      expect(
        resolveWindowShortcutAction(customInput, platform, {
          'workspace.delete': ['Mod+Alt+X']
        })
      ).toBeNull()
      expect(
        resolveWindowShortcutAction(
          customInput,
          platform,
          { 'workspace.delete': ['Mod+Alt+X'] },
          { context: 'terminal', terminalShortcutPolicy: 'terminal-first' }
        )
      ).toBeNull()
    }
  )

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

  it('resolves letter shortcuts by layout-aware key, with code as fallback', () => {
    // Prefer layout-aware letter keys over physical QWERTY codes; only empty/nonletter IME/dead-key values need code fallback.

    // Dvorak letters sit on different physical codes; resolve the typed letters.
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
        { code: 'KeyV', key: 'k', meta: true, alt: false, shift: false },
        { type: 'toggleWorktreePalette' }
      ]
    ]
    for (const [input, expected] of dvorak) {
      expect(resolveWindowShortcutAction(input, 'darwin')).toEqual(expected)
    }

    // Physical QWERTY-B types x on Dvorak, so its Cut chord must not open the sidebar.
    expect(
      resolveWindowShortcutAction(
        { code: 'KeyB', key: 'x', meta: true, alt: false, shift: false },
        'darwin'
      )
    ).toBeNull()

    // Empty/dead-key/modifier key values still need physical-code fallback.
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

  it('resolves an allowlisted action from a synthetic double-tap input', () => {
    const overrides: KeybindingOverrides = { 'worktree.quickOpen': ['DoubleTap+Shift'] }
    expect(
      resolveWindowShortcutAction({ doubleTapModifier: 'Shift' }, 'darwin', overrides)
    ).toEqual({ type: 'openQuickOpen' })

    expect(
      resolveWindowShortcutAction({ doubleTapModifier: 'Alt' }, 'darwin', overrides)
    ).toBeNull()

    // Synthetic double taps have no key, so implicit numeric ranges must not match them.
    expect(resolveWindowShortcutAction({ doubleTapModifier: 'Cmd' }, 'darwin')).toBeNull()
  })
})
