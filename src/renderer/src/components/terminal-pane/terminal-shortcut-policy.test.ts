import { describe, expect, it, vi } from 'vitest'
import { createTerminalNativeOnlyShortcutTracker } from './terminal-native-only-shortcut'
import {
  resolveTerminalShortcutAction,
  type TerminalShortcutEvent
} from './terminal-shortcut-policy'

function event(overrides: Partial<TerminalShortcutEvent>): TerminalShortcutEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides
  }
}

describe('resolveTerminalShortcutAction', () => {
  it('preserves macOS readline ctrl chords for the shell', () => {
    const passthroughCases = [
      event({ key: 'r', code: 'KeyR', ctrlKey: true }),
      event({ key: 'u', code: 'KeyU', ctrlKey: true }),
      event({ key: 'e', code: 'KeyE', ctrlKey: true }),
      event({ key: 'a', code: 'KeyA', ctrlKey: true }),
      event({ key: 'w', code: 'KeyW', ctrlKey: true }),
      event({ key: 'k', code: 'KeyK', ctrlKey: true })
    ]

    for (const input of passthroughCases) {
      expect(resolveTerminalShortcutAction(input, true)).toBeNull()
    }
  })

  it('resolves the explicit macOS terminal shortcut allowlist', () => {
    expect(
      resolveTerminalShortcutAction(event({ key: 'f', code: 'KeyF', metaKey: true }), true)
    ).toEqual({
      type: 'toggleSearch'
    })
    expect(
      resolveTerminalShortcutAction(event({ key: 'k', code: 'KeyK', metaKey: true }), true)
    ).toEqual({
      type: 'clearActivePane'
    })
    expect(
      resolveTerminalShortcutAction(event({ key: 'w', code: 'KeyW', metaKey: true }), true)
    ).toEqual({
      type: 'closeActivePane'
    })
    expect(
      resolveTerminalShortcutAction(event({ key: 'd', code: 'KeyD', metaKey: true }), true)
    ).toEqual({ type: 'splitActivePane', direction: 'vertical' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'd', code: 'KeyD', metaKey: true, shiftKey: true }),
        true
      )
    ).toEqual({ type: 'splitActivePane', direction: 'horizontal' })
    expect(
      resolveTerminalShortcutAction(event({ key: '[', code: 'BracketLeft', metaKey: true }), true)
    ).toEqual({ type: 'focusPane', direction: 'previous' })
    expect(
      resolveTerminalShortcutAction(event({ key: ']', code: 'BracketRight', metaKey: true }), true)
    ).toEqual({ type: 'focusPane', direction: 'next' })
  })

  it('keeps inactive shift-enter and delete helpers explicit', () => {
    expect(
      resolveTerminalShortcutAction(event({ key: 'Enter', code: 'Enter', shiftKey: true }), true)
    ).toEqual({
      type: 'sendInput',
      data: '\x1b\r'
    })
    expect(resolveTerminalShortcutAction(event({ key: 'Backspace', ctrlKey: true }), true)).toEqual(
      { type: 'sendInput', data: '\x17' }
    )
    expect(resolveTerminalShortcutAction(event({ key: 'Backspace', metaKey: true }), true)).toEqual(
      { type: 'sendInput', data: '\x15' }
    )
    expect(resolveTerminalShortcutAction(event({ key: 'Delete', metaKey: true }), true)).toEqual({
      type: 'sendInput',
      data: '\x0b'
    })
    expect(resolveTerminalShortcutAction(event({ key: 'Backspace', altKey: true }), true)).toEqual({
      type: 'sendInput',
      data: '\x1b\x7f'
    })
  })

  it('uses the Codex-compatible Shift+Enter sequence on Windows win32-input-mode panes', () => {
    // Legacy/default Codex-on-PowerShell encoding must insert newline instead of ignoring the chord.
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Enter', code: 'Enter', shiftKey: true }),
        false,
        'false',
        0,
        true
      )
    ).toEqual({
      type: 'sendInput',
      data: '\x1b\r'
    })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Enter', code: 'Enter', shiftKey: true }),
        false,
        'false',
        0,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        () => 'alt-enter'
      )
    ).toEqual({ type: 'sendInput', data: '\x1b\r' })
  })

  it('sends CSI-u Shift+Enter to Windows panes whose active agent requires it (#7620)', () => {
    // Droid parses CSI-u directly; Alt+Enter would submit instead of newline.
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Enter', code: 'Enter', shiftKey: true }),
        false,
        'false',
        0,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        () => 'csi-u'
      )
    ).toEqual({ type: 'sendInput', data: '\x1b[13;2u' })
  })

  it('uses CSI-u for a non-Windows PTY reached from Windows only while Kitty is active', () => {
    const getWindowsShiftEnterEncoding = vi.fn(() => 'csi-u' as const)
    const resolve = (kittyActive: boolean) =>
      resolveTerminalShortcutAction(
        event({ key: 'Enter', code: 'Enter', shiftKey: true }),
        false,
        'false',
        0,
        true,
        undefined,
        undefined,
        () => (kittyActive ? 1 : 0),
        undefined,
        getWindowsShiftEnterEncoding,
        () => false
      )
    expect(resolve(true)).toEqual({ type: 'sendInput', data: '\x1b[13;2u' })
    expect(resolve(false)).toEqual({ type: 'sendInput', data: '\x1b\r' })
    expect(getWindowsShiftEnterEncoding).not.toHaveBeenCalled()
  })

  it('uses CSI-u Shift+Enter off Windows only while Kitty keyboard is active', () => {
    for (const encoding of [() => 'csi-u' as const, () => 'alt-enter' as const, undefined]) {
      const resolve = (kittyActive: boolean) =>
        resolveTerminalShortcutAction(
          event({ key: 'Enter', code: 'Enter', shiftKey: true }),
          false,
          'false',
          0,
          false,
          undefined,
          undefined,
          () => (kittyActive ? 1 : 0),
          undefined,
          encoding
        )
      expect(resolve(true)).toEqual({ type: 'sendInput', data: '\x1b[13;2u' })
      expect(resolve(false)).toEqual({ type: 'sendInput', data: '\x1b\r' })
    }
  })

  it('keeps host and agent lookups off unrelated keystrokes', () => {
    const isLocalWindowsConptyPane = vi.fn(() => true)
    const getKittyKeyboardFlagsActivePane = vi.fn(() => 1)
    const getWindowsShiftEnterEncoding = vi.fn(() => 'csi-u' as const)
    const isWindowsTerminalHost = vi.fn(() => true)

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'a', code: 'KeyA' }),
        false,
        'false',
        0,
        true,
        undefined,
        isLocalWindowsConptyPane,
        getKittyKeyboardFlagsActivePane,
        undefined,
        getWindowsShiftEnterEncoding,
        isWindowsTerminalHost
      )
    ).toBeNull()
    expect(isLocalWindowsConptyPane).not.toHaveBeenCalled()
    expect(getWindowsShiftEnterEncoding).not.toHaveBeenCalled()
    expect(isWindowsTerminalHost).not.toHaveBeenCalled()
    expect(getKittyKeyboardFlagsActivePane).not.toHaveBeenCalled()

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Enter', code: 'Enter', shiftKey: true }),
        false,
        'false',
        0,
        true,
        undefined,
        isLocalWindowsConptyPane,
        getKittyKeyboardFlagsActivePane,
        undefined,
        getWindowsShiftEnterEncoding,
        isWindowsTerminalHost
      )
    ).toEqual({ type: 'sendInput', data: '\x1b[13;2u' })
    expect(isLocalWindowsConptyPane).not.toHaveBeenCalled()
    expect(getWindowsShiftEnterEncoding).toHaveBeenCalledTimes(1)
    expect(isWindowsTerminalHost).toHaveBeenCalledTimes(1)
    expect(getKittyKeyboardFlagsActivePane).not.toHaveBeenCalled()

    isWindowsTerminalHost.mockReturnValue(false)
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Enter', code: 'Enter', shiftKey: true }),
        false,
        'false',
        0,
        true,
        undefined,
        isLocalWindowsConptyPane,
        getKittyKeyboardFlagsActivePane,
        undefined,
        getWindowsShiftEnterEncoding,
        isWindowsTerminalHost
      )
    ).toEqual({ type: 'sendInput', data: '\x1b[13;2u' })
    expect(isLocalWindowsConptyPane).not.toHaveBeenCalled()
    expect(getWindowsShiftEnterEncoding).toHaveBeenCalledTimes(1)
    expect(isWindowsTerminalHost).toHaveBeenCalledTimes(2)
    expect(getKittyKeyboardFlagsActivePane).toHaveBeenCalledTimes(1)
  })

  it('honors Kitty negotiation for a Windows PTY reached from macOS', () => {
    const getWindowsShiftEnterEncoding = vi.fn(() => 'alt-enter' as const)
    const resolve = (kittyActive: boolean) =>
      resolveTerminalShortcutAction(
        event({ key: 'Enter', code: 'Enter', shiftKey: true }),
        true,
        'false',
        0,
        false,
        undefined,
        undefined,
        () => (kittyActive ? 1 : 0),
        undefined,
        getWindowsShiftEnterEncoding,
        () => true
      )
    expect(resolve(true)).toEqual({ type: 'sendInput', data: '\x1b[13;2u' })
    expect(resolve(false)).toEqual({ type: 'sendInput', data: '\x1b\r' })
    expect(getWindowsShiftEnterEncoding).toHaveBeenCalledTimes(2)
  })

  it('protects local ConPTY shells without regressing query-only Ctrl+Enter consumers', () => {
    const getWindowsShiftEnterEncoding = vi.fn(() => 'csi-u' as const)
    const isLocalWindowsConptyPane = vi.fn(() => true)
    const getKittyKeyboardFlagsActivePane = vi.fn(() => 0)
    const hasCtrlEnterCsiUAuthority = vi.fn(() => false)
    const csiU = { type: 'sendInput', data: '\x1b[13;5u' }
    const legacyCr = { type: 'sendInput', data: '\r' }
    const resolveCtrlEnter = (
      localConpty: boolean,
      kittyActive: boolean,
      trustedConsumer: boolean
    ) => {
      isLocalWindowsConptyPane.mockReturnValue(localConpty)
      getKittyKeyboardFlagsActivePane.mockReturnValue(kittyActive ? 1 : 0)
      hasCtrlEnterCsiUAuthority.mockReturnValue(trustedConsumer)
      return resolveTerminalShortcutAction(
        event({ key: 'Enter', code: 'Enter', ctrlKey: true }),
        false,
        'false',
        0,
        true,
        undefined,
        isLocalWindowsConptyPane,
        getKittyKeyboardFlagsActivePane,
        undefined,
        getWindowsShiftEnterEncoding,
        () => true,
        'orca-first',
        hasCtrlEnterCsiUAuthority
      )
    }

    expect(resolveCtrlEnter(true, false, false)).toEqual(legacyCr)
    expect(resolveCtrlEnter(true, true, false)).toEqual(csiU)
    expect(resolveCtrlEnter(true, false, true)).toEqual(csiU)
    hasCtrlEnterCsiUAuthority.mockClear()
    expect(resolveCtrlEnter(false, false, false)).toEqual(csiU)
    expect(hasCtrlEnterCsiUAuthority).not.toHaveBeenCalled()
    expect(getWindowsShiftEnterEncoding).not.toHaveBeenCalled()

    // Missing pane-host context preserves the established Droid/Grok chord.
    expect(
      resolveTerminalShortcutAction(event({ key: 'Enter', code: 'Enter', ctrlKey: true }), false)
    ).toEqual(csiU)

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: true }),
        true
      )
    ).toBeNull()
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Enter', code: 'Enter', ctrlKey: true, metaKey: true }),
        true
      )
    ).toBeNull()
  })

  it('translates Cmd+←/→ on macOS to readline start/end-of-line (Ctrl+A/E)', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true }),
        true
      )
    ).toEqual({ type: 'sendInput', data: '\x01' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight', code: 'ArrowRight', metaKey: true }),
        true
      )
    ).toEqual({ type: 'sendInput', data: '\x05' })

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, shiftKey: true }),
        true
      )
    ).toBeNull()
  })

  it('maps Cmd+↑/↓ on macOS to terminal scrollback top/bottom navigation', () => {
    expect(
      resolveTerminalShortcutAction(event({ key: 'ArrowUp', code: 'ArrowUp', metaKey: true }), true)
    ).toEqual({ type: 'scrollViewport', position: 'top' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowDown', code: 'ArrowDown', metaKey: true }),
        true
      )
    ).toEqual({ type: 'scrollViewport', position: 'bottom' })

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowUp', code: 'ArrowUp', metaKey: true, shiftKey: true }),
        true
      )
    ).toBeNull()
  })

  it('preserves existing non-Mac terminal pane shortcuts', () => {
    expect(
      resolveTerminalShortcutAction(event({ key: 'f', code: 'KeyF', ctrlKey: true }), false)
    ).toEqual({ type: 'toggleSearch' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'c', code: 'KeyC', ctrlKey: true, shiftKey: true }),
        false
      )
    ).toEqual({ type: 'copySelection' })
    expect(
      resolveTerminalShortcutAction(event({ key: 'r', code: 'KeyR', ctrlKey: true }), false)
    ).toBeNull()
    expect(
      resolveTerminalShortcutAction(event({ key: 'k', code: 'KeyK', ctrlKey: true }), false)
    ).toEqual({ type: 'clearActivePane' })
    expect(
      resolveTerminalShortcutAction(event({ key: 'w', code: 'KeyW', ctrlKey: true }), false)
    ).toEqual({ type: 'closeActivePane' })
  })

  it('applies custom terminal pane keybindings', () => {
    const keybindings = {
      'terminal.clear': ['Ctrl+Alt+K'],
      'terminal.search': []
    }

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true }),
        false,
        'false',
        0,
        false,
        keybindings
      )
    ).toBeNull()
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true }),
        false,
        'false',
        0,
        false,
        keybindings
      )
    ).toEqual({ type: 'clearActivePane' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'f', code: 'KeyF', ctrlKey: true }),
        false,
        'false',
        0,
        false,
        keybindings
      )
    ).toBeNull()
  })

  it('resolves equalize pane sizes only when users assign it', () => {
    expect(
      resolveTerminalShortcutAction(event({ key: '=', code: 'Equal', metaKey: true }), true)
    ).toBeNull()
    expect(
      resolveTerminalShortcutAction(
        event({ key: '=', code: 'Equal', metaKey: true }),
        true,
        'false',
        0,
        false,
        { 'terminal.equalizePaneSizes': ['Mod+Equal'] }
      )
    ).toEqual({ type: 'equalizePaneSizes' })
  })

  it('resolves terminal title actions only when users assign them', () => {
    expect(
      resolveTerminalShortcutAction(event({ key: 't', code: 'KeyT', metaKey: true }), true)
    ).toBeNull()
    expect(
      resolveTerminalShortcutAction(
        event({ key: 't', code: 'KeyT', metaKey: true }),
        true,
        'false',
        0,
        false,
        { 'terminal.setTitle': ['Mod+T'] }
      )
    ).toEqual({ type: 'setTitle' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 't', code: 'KeyT', metaKey: true, altKey: true }),
        true,
        'false',
        0,
        false,
        { 'terminal.clearPaneTitle': ['Mod+Alt+T'] }
      )
    ).toEqual({ type: 'clearPaneTitle' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 't', code: 'KeyT', metaKey: true, altKey: true, repeat: true }),
        true,
        'false',
        0,
        false,
        { 'terminal.clearPaneTitle': ['Mod+Alt+T'] }
      )
    ).toBeNull()
  })

  it('lets Ctrl+D pass through as EOF on non-Mac, requires Shift for split (#586)', () => {
    expect(
      resolveTerminalShortcutAction(event({ key: 'd', code: 'KeyD', ctrlKey: true }), false)
    ).toBeNull()

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'd', code: 'KeyD', ctrlKey: true, shiftKey: true }),
        false
      )
    ).toEqual({ type: 'splitActivePane', direction: 'vertical' })

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'd', code: 'KeyD', altKey: true, shiftKey: true }),
        false
      )
    ).toEqual({ type: 'splitActivePane', direction: 'horizontal' })

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'd', code: 'KeyD', altKey: true, shiftKey: true }),
        true
      )
    ).toBeNull()

    expect(
      resolveTerminalShortcutAction(event({ key: 'd', code: 'KeyD', altKey: true }), false)
    ).toBeNull()
  })

  it('translates alt+arrow to readline word-nav escapes on both platforms', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }),
        true
      )
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight', code: 'ArrowRight', altKey: true }),
        true
      )
    ).toEqual({ type: 'sendInput', data: '\x1bf' })

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }),
        false
      )
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight', code: 'ArrowRight', altKey: true }),
        false
      )
    ).toEqual({ type: 'sendInput', data: '\x1bf' })

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true, shiftKey: true }),
        true
      )
    ).toBeNull()

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true, ctrlKey: true }),
        true
      )
    ).toBeNull()

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, altKey: true }),
        false
      )
    ).toBeNull()

    expect(
      resolveTerminalShortcutAction(event({ key: 'ArrowLeft', code: 'ArrowLeft' }), true)
    ).toBeNull()
  })

  it('translates macOS Option+B/F/D to readline escape sequences in compose mode', () => {
    // Compose-mode macOS rewrites event.key; physical code preserves B/F/D readline matching.
    expect(
      resolveTerminalShortcutAction(event({ key: '∫', code: 'KeyB', altKey: true }), true, 'false')
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
    expect(
      resolveTerminalShortcutAction(event({ key: 'ƒ', code: 'KeyF', altKey: true }), true, 'false')
    ).toEqual({ type: 'sendInput', data: '\x1bf' })
    expect(
      resolveTerminalShortcutAction(event({ key: '∂', code: 'KeyD', altKey: true }), true, 'false')
    ).toEqual({ type: 'sendInput', data: '\x1bd' })

    expect(
      resolveTerminalShortcutAction(event({ key: 'b', code: 'KeyB', altKey: true }), false)
    ).toBeNull()

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'B', code: 'KeyB', altKey: true, shiftKey: true }),
        true,
        'false'
      )
    ).toBeNull()
  })

  it('sends Esc+letter for any Option+letter when left Option acts as alt', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: '¬', code: 'KeyL', altKey: true }),
        true,
        'left',
        1
      )
    ).toEqual({ type: 'sendInput', data: '\x1bl' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: '†', code: 'KeyT', altKey: true }),
        true,
        'left',
        1
      )
    ).toEqual({ type: 'sendInput', data: '\x1bt' })

    expect(
      resolveTerminalShortcutAction(
        event({ key: '∫', code: 'KeyB', altKey: true }),
        true,
        'left',
        2
      )
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: '¬', code: 'KeyL', altKey: true }),
        true,
        'left',
        2
      )
    ).toBeNull()
  })

  it('handles side-specific Alt and leaves global legacy Alt with the terminal engine', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: '≥', code: 'Period', altKey: true }),
        true,
        'right',
        2
      )
    ).toEqual({ type: 'sendInput', data: '\x1b.' })

    expect(
      resolveTerminalShortcutAction(
        event({ key: '¬', code: 'KeyL', altKey: true }),
        true,
        'right',
        2
      )
    ).toEqual({ type: 'sendInput', data: '\x1bl' })

    expect(
      resolveTerminalShortcutAction(
        event({ key: '¬', code: 'KeyL', altKey: true }),
        true,
        'right',
        1
      )
    ).toBeNull()
    expect(
      resolveTerminalShortcutAction(event({ key: 'b', code: 'KeyB', altKey: true }), true, 'true')
    ).toBeNull()
  })

  it('keeps Cmd+D and Cmd+Shift+D for split on macOS', () => {
    expect(
      resolveTerminalShortcutAction(event({ key: 'd', code: 'KeyD', metaKey: true }), true)
    ).toEqual({ type: 'splitActivePane', direction: 'vertical' })

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'd', code: 'KeyD', metaKey: true, shiftKey: true }),
        true
      )
    ).toEqual({ type: 'splitActivePane', direction: 'horizontal' })
  })

  it('resolves terminal.switchInputSource via explicit override (for OS input-source chords)', () => {
    // Configured native-only chords must preserve browser default instead of terminal cancellation.
    const overrides = { 'terminal.switchInputSource': ['Shift+Space'] }
    expect(
      resolveTerminalShortcutAction(
        event({ key: ' ', code: 'Space', shiftKey: true }),
        true,
        'false',
        0,
        false,
        overrides
      )
    ).toEqual({ type: 'switchInputSource' })

    const otherChord = { 'terminal.switchInputSource': ['Ctrl+Space'] }
    expect(
      resolveTerminalShortcutAction(
        event({ key: ' ', code: 'Space', ctrlKey: true }),
        false,
        'false',
        0,
        false,
        otherChord
      )
    ).toEqual({ type: 'switchInputSource' })
  })

  it('does not resolve switchInputSource for ordinary chords without override', () => {
    expect(
      resolveTerminalShortcutAction(event({ key: ' ', code: 'Space', shiftKey: true }), true)
    ).toBeNull()
  })

  it('suppresses the full companion event sequence for a native-only shortcut', () => {
    const tracker = createTerminalNativeOnlyShortcutTracker()
    tracker.armKeyDown(event({ key: ' ', code: 'Space', shiftKey: true }))

    expect(tracker.consumeCompanion({ type: 'keypress', key: ' ', code: 'Space' })).toBe(true)
    expect(tracker.consumeCompanion({ type: 'keyup', key: ' ', code: 'Space' })).toBe(true)
    expect(tracker.consumeCompanion({ type: 'keyup', key: ' ', code: 'Space' })).toBe(false)
  })
})

describe('kitty keyboard protocol panes', () => {
  const kittyActive = (): number => 1
  const kittyInactive = (): number => 0

  const resolveKitty = (
    input: TerminalShortcutEvent,
    macOptionAsAlt: 'true' | 'false' | 'left' | 'right' = 'false',
    optionKeyLocations: 0 | 1 | 2 | 3 = 0,
    active: () => number = kittyActive
  ) =>
    resolveTerminalShortcutAction(
      input,
      true,
      macOptionAsAlt,
      optionKeyLocations,
      false,
      undefined,
      undefined,
      active
    )

  it('types Option-composed letters on a compose side instead of chords (#20171)', () => {
    // Compose layouts need their letters; TUI hotkeys remain available on configured Alt sides.
    expect(resolveKitty(event({ key: 'π', code: 'KeyP', altKey: true }))).toEqual({
      type: 'sendInput',
      data: 'π'
    })
    expect(resolveKitty(event({ key: 'µ', code: 'KeyM', altKey: true }))).toEqual({
      type: 'sendInput',
      data: 'µ'
    })
  })

  it('types shifted compositions on a compose side instead of chords', () => {
    expect(resolveKitty(event({ key: '∏', code: 'KeyP', altKey: true, shiftKey: true }))).toEqual({
      type: 'sendInput',
      data: '∏'
    })
  })

  it('types composed digits and punctuation; configured Alt keeps chords', () => {
    expect(resolveKitty(event({ key: '¡', code: 'Digit1', altKey: true }))).toEqual({
      type: 'sendInput',
      data: '¡'
    })
    expect(resolveKitty(event({ key: '≥', code: 'Period', altKey: true }))).toEqual({
      type: 'sendInput',
      data: '≥'
    })
    expect(resolveKitty(event({ key: 'p', code: 'KeyP', altKey: true }), 'true')).toEqual({
      type: 'sendInput',
      data: '\x1b[112;3u'
    })
  })

  it('exempts dead keys so Option composition still starts', () => {
    expect(resolveKitty(event({ key: 'Dead', code: 'KeyE', altKey: true }))).toBeNull()
  })

  it('keeps shift+Option composition untouched in non-kitty panes', () => {
    expect(
      resolveKitty(
        event({ key: '∏', code: 'KeyP', altKey: true, shiftKey: true }),
        'false',
        0,
        kittyInactive
      )
    ).toBeNull()
    expect(
      resolveKitty(
        event({ key: '∏', code: 'KeyP', altKey: true, shiftKey: true }),
        'left',
        1,
        kittyInactive
      )
    ).toBeNull()
  })

  it('keeps compose-mode behavior unchanged when the pane is not kitty-active', () => {
    expect(
      resolveKitty(event({ key: 'π', code: 'KeyP', altKey: true }), 'false', 0, kittyInactive)
    ).toBeNull()
    expect(
      resolveKitty(event({ key: '∫', code: 'KeyB', altKey: true }), 'false', 0, kittyInactive)
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
  })

  it('types on the compose-side Option; the Alt side keeps CSI-u in left/right modes', () => {
    expect(resolveKitty(event({ key: '¬', code: 'KeyL', altKey: true }), 'left', 2)).toEqual({
      type: 'sendInput',
      data: '¬'
    })
    expect(resolveKitty(event({ key: '¬', code: 'KeyL', altKey: true }), 'left', 1)).toEqual({
      type: 'sendInput',
      data: '\x1b[108;3u'
    })
  })

  it('yields Alt+Arrow and Alt+Backspace to xterm kitty encoding', () => {
    expect(resolveKitty(event({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }))).toBeNull()
    expect(resolveKitty(event({ key: 'Backspace', code: 'Backspace', altKey: true }))).toBeNull()
    expect(
      resolveKitty(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }),
        'false',
        0,
        kittyInactive
      )
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
    expect(
      resolveKitty(
        event({ key: 'Backspace', code: 'Backspace', altKey: true }),
        'false',
        0,
        kittyInactive
      )
    ).toEqual({ type: 'sendInput', data: '\x1b\x7f' })
  })

  it('does not intercept Option chords with Cmd or Ctrl held', () => {
    expect(resolveKitty(event({ key: 'π', code: 'KeyP', altKey: true, metaKey: true }))).toBeNull()
    expect(resolveKitty(event({ key: 'π', code: 'KeyP', altKey: true, ctrlKey: true }))).toBeNull()
  })

  it('resolves the kitty base key through the active layout map when provided', () => {
    const resolveWithLayout = (
      input: TerminalShortcutEvent,
      layoutCharacterForCode: (code: string, shifted: boolean) => string | undefined
    ) =>
      resolveTerminalShortcutAction(
        input,
        true,
        'false',
        0,
        false,
        undefined,
        undefined,
        kittyActive,
        layoutCharacterForCode
      )

    // AZERTY Semicolon produces M; layout-map truth must outrank US punctuation when encoding alt+m.
    const azerty = (code: string): string | undefined => (code === 'Semicolon' ? 'm' : undefined)
    expect(resolveWithLayout(event({ key: 'm', code: 'Semicolon', altKey: true }), azerty)).toEqual(
      { type: 'sendInput', data: '\x1b[109;3u' }
    )

    const colemak = (code: string): string | undefined => (code === 'KeyR' ? 'p' : undefined)
    expect(resolveWithLayout(event({ key: 'p', code: 'KeyR', altKey: true }), colemak)).toEqual({
      type: 'sendInput',
      data: '\x1b[112;3u'
    })

    const empty = (): string | undefined => undefined
    expect(resolveWithLayout(event({ key: 'p', code: 'KeyP', altKey: true }), empty)).toEqual({
      type: 'sendInput',
      data: '\x1b[112;3u'
    })
  })
})
