import { describe, expect, it, vi } from 'vitest'
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

  it('keeps shift-enter and delete helpers explicit', () => {
    expect(
      resolveTerminalShortcutAction(event({ key: 'Enter', code: 'Enter', shiftKey: true }), true)
    ).toEqual({
      type: 'sendInput',
      data: '\x1b[13;2u'
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
    // Default and explicit legacy encodings both keep Codex-on-PowerShell
    // newlining instead of ignoring the chord.
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
    // Why: droid parses CSI-u directly and treats the Alt+Enter byte as a plain
    // Enter that submits, so its pane capability must produce `\x1b[13;2u`.
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

  it('preserves the Windows fallback for SSH, WSL, and remote panes', () => {
    // Why: a Windows client cannot safely infer a remote peer's decoder, so the
    // local Droid exception must not broaden main's existing remote behavior.
    const isLocalWindowsConptyPane = vi.fn(() => false)
    const getWindowsShiftEnterEncoding = vi.fn(() => 'csi-u' as const)
    for (let index = 0; index < 2; index += 1) {
      expect(
        resolveTerminalShortcutAction(
          event({ key: 'Enter', code: 'Enter', shiftKey: true }),
          false,
          'false',
          0,
          true,
          undefined,
          isLocalWindowsConptyPane,
          undefined,
          undefined,
          getWindowsShiftEnterEncoding
        )
      ).toEqual({ type: 'sendInput', data: '\x1b\r' })
    }
    expect(isLocalWindowsConptyPane).toHaveBeenCalledTimes(2)
    expect(getWindowsShiftEnterEncoding).not.toHaveBeenCalled()
  })

  it('always uses CSI-u Shift+Enter off Windows regardless of Windows encoding', () => {
    for (const encoding of [() => 'csi-u' as const, () => 'alt-enter' as const, undefined]) {
      expect(
        resolveTerminalShortcutAction(
          event({ key: 'Enter', code: 'Enter', shiftKey: true }),
          false,
          'false',
          0,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          encoding
        )
      ).toEqual({ type: 'sendInput', data: '\x1b[13;2u' })
    }
  })

  it('keeps ConPTY and agent lookups off unrelated keystrokes', () => {
    const isLocalWindowsConptyPane = vi.fn(() => true)
    const getWindowsShiftEnterEncoding = vi.fn(() => 'csi-u' as const)

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'a', code: 'KeyA' }),
        false,
        'false',
        0,
        true,
        undefined,
        isLocalWindowsConptyPane,
        undefined,
        undefined,
        getWindowsShiftEnterEncoding
      )
    ).toBeNull()
    expect(isLocalWindowsConptyPane).not.toHaveBeenCalled()
    expect(getWindowsShiftEnterEncoding).not.toHaveBeenCalled()

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Enter', code: 'Enter', shiftKey: true }),
        false,
        'false',
        0,
        true,
        undefined,
        isLocalWindowsConptyPane,
        undefined,
        undefined,
        getWindowsShiftEnterEncoding
      )
    ).toEqual({ type: 'sendInput', data: '\x1b[13;2u' })
    expect(isLocalWindowsConptyPane).toHaveBeenCalledTimes(1)
    expect(getWindowsShiftEnterEncoding).toHaveBeenCalledTimes(1)

    isLocalWindowsConptyPane.mockReturnValue(false)
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Enter', code: 'Enter', shiftKey: true }),
        false,
        'false',
        0,
        true,
        undefined,
        isLocalWindowsConptyPane,
        undefined,
        undefined,
        getWindowsShiftEnterEncoding
      )
    ).toEqual({ type: 'sendInput', data: '\x1b\r' })
    expect(isLocalWindowsConptyPane).toHaveBeenCalledTimes(2)
    expect(getWindowsShiftEnterEncoding).toHaveBeenCalledTimes(1)
  })

  it('forwards Ctrl+Enter as the kitty CSI-u chord so TUIs can cue instead of send', () => {
    // Why: xterm.js collapses Ctrl+Enter to a bare CR; intercept upstream and
    // emit the kitty sequence (modifier code 5 = Ctrl) so probing TUIs receive
    // the distinct chord on every platform.
    expect(
      resolveTerminalShortcutAction(event({ key: 'Enter', code: 'Enter', ctrlKey: true }), true)
    ).toEqual({ type: 'sendInput', data: '\x1b[13;5u' })
    expect(
      resolveTerminalShortcutAction(event({ key: 'Enter', code: 'Enter', ctrlKey: true }), false)
    ).toEqual({ type: 'sendInput', data: '\x1b[13;5u' })
    // Windows uses the same kitty sequence for now: no TUI is known to treat the
    // CSI-u Ctrl+Enter form as inert (cf. the Shift+Enter Codex-on-PowerShell case).
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Enter', code: 'Enter', ctrlKey: true }),
        false,
        'false',
        0,
        true
      )
    ).toEqual({ type: 'sendInput', data: '\x1b[13;5u' })

    // Modifier combos that are NOT plain Ctrl+Enter must keep falling through.
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

    // Cmd+Shift+Arrow is a different chord (selection) — don't intercept.
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

    // Cmd+Shift+Arrow is selection territory; leave it to focused apps/shells.
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
    // Ctrl+D without Shift on Windows/Linux must NOT trigger split — it's EOF
    expect(
      resolveTerminalShortcutAction(event({ key: 'd', code: 'KeyD', ctrlKey: true }), false)
    ).toBeNull()

    // Ctrl+Shift+D on Windows/Linux splits the pane right (vertical)
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'd', code: 'KeyD', ctrlKey: true, shiftKey: true }),
        false
      )
    ).toEqual({ type: 'splitActivePane', direction: 'vertical' })

    // Alt+Shift+D on Windows/Linux splits the pane down (horizontal)
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'd', code: 'KeyD', altKey: true, shiftKey: true }),
        false
      )
    ).toEqual({ type: 'splitActivePane', direction: 'horizontal' })

    // Alt+Shift+D should NOT trigger split-down on Mac (Mac uses Cmd+Shift+D)
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'd', code: 'KeyD', altKey: true, shiftKey: true }),
        true
      )
    ).toBeNull()

    // Alt+D (no Shift) on Windows/Linux must pass through for readline forward-word-delete
    expect(
      resolveTerminalShortcutAction(event({ key: 'd', code: 'KeyD', altKey: true }), false)
    ).toBeNull()
  })

  it('translates alt+arrow to readline word-nav escapes on both platforms', () => {
    // macOS: option+←/→ → \eb / \ef (readline backward-word / forward-word)
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

    // Linux/Windows: alt+←/→ produces the same escapes (platform-agnostic chord)
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

    // alt+shift+arrow is a different chord (select-word in some shells) — don't
    // intercept, let xterm.js / the shell handle it.
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true, shiftKey: true }),
        true
      )
    ).toBeNull()

    // alt+ctrl+arrow is a different chord entirely — passthrough.
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true, ctrlKey: true }),
        true
      )
    ).toBeNull()

    // Ctrl+Alt+Arrow (Linux workspace switching on some desktops) must pass through on non-Mac.
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, altKey: true }),
        false
      )
    ).toBeNull()

    // Regression guard: plain ArrowLeft must still pass through untouched.
    expect(
      resolveTerminalShortcutAction(event({ key: 'ArrowLeft', code: 'ArrowLeft' }), true)
    ).toBeNull()
  })

  it('translates macOS Option+B/F/D to readline escape sequences in compose mode', () => {
    // With macOptionAsAlt='false' (compose), xterm.js doesn't translate these.
    // Matches on event.code because macOS composition replaces event.key.
    expect(
      resolveTerminalShortcutAction(event({ key: '∫', code: 'KeyB', altKey: true }), true, 'false')
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
    expect(
      resolveTerminalShortcutAction(event({ key: 'ƒ', code: 'KeyF', altKey: true }), true, 'false')
    ).toEqual({ type: 'sendInput', data: '\x1bf' })
    expect(
      resolveTerminalShortcutAction(event({ key: '∂', code: 'KeyD', altKey: true }), true, 'false')
    ).toEqual({ type: 'sendInput', data: '\x1bd' })

    // On Linux/Windows, Alt+B/F/D must still pass through
    expect(
      resolveTerminalShortcutAction(event({ key: 'b', code: 'KeyB', altKey: true }), false)
    ).toBeNull()

    // Option+Shift+B/F/D should not be intercepted (different chord)
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'B', code: 'KeyB', altKey: true, shiftKey: true }),
        true,
        'false'
      )
    ).toBeNull()
  })

  it('sends Esc+letter for any Option+letter when left Option acts as alt', () => {
    // Left Option (optionKeyLocation=1) in 'left' mode: full Meta for any letter key
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

    // Right Option (optionKeyLocation=2) in 'left' mode: compose side, only B/F/D patched
    expect(
      resolveTerminalShortcutAction(
        event({ key: '∫', code: 'KeyB', altKey: true }),
        true,
        'left',
        2
      )
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
    // Right Option+L should pass through (compose character)
    expect(
      resolveTerminalShortcutAction(
        event({ key: '¬', code: 'KeyL', altKey: true }),
        true,
        'left',
        2
      )
    ).toBeNull()
  })

  it('sends Esc+letter for any Option+letter when right Option acts as alt', () => {
    // Right Option (optionKeyLocation=2) in 'right' mode: full Meta, including punctuation
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

    // Left Option (optionKeyLocation=1) in 'right' mode: compose side, only B/F/D patched
    expect(
      resolveTerminalShortcutAction(
        event({ key: '¬', code: 'KeyL', altKey: true }),
        true,
        'right',
        1
      )
    ).toBeNull()
  })

  it('does not intercept Option+letter in true mode (xterm handles it)', () => {
    // In 'true' mode, macOptionIsMeta is enabled in xterm, so no compensation needed
    // Our handler still fires but is gated by macOptionAsAlt !== 'true'
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
})

describe('kitty keyboard protocol panes', () => {
  const kittyActive = (): boolean => true
  const kittyInactive = (): boolean => false

  const resolveKitty = (
    input: TerminalShortcutEvent,
    macOptionAsAlt: 'true' | 'false' | 'left' | 'right' = 'false',
    optionKeyLocation = 0,
    active: () => boolean = kittyActive
  ) =>
    resolveTerminalShortcutAction(
      input,
      true,
      macOptionAsAlt,
      optionKeyLocation,
      false,
      undefined,
      undefined,
      active
    )

  it('encodes Option+letter as kitty CSI-u with the physical base key in compose mode', () => {
    // macOS composition reports key='π' for Option+P on ABC/compose layouts;
    // OMP binds alt+p (temporary model) and alt+m (model selector).
    expect(resolveKitty(event({ key: 'π', code: 'KeyP', altKey: true }))).toEqual({
      type: 'sendInput',
      data: '\x1b[112;3u'
    })
    expect(resolveKitty(event({ key: 'µ', code: 'KeyM', altKey: true }))).toEqual({
      type: 'sendInput',
      data: '\x1b[109;3u'
    })
  })

  it('includes shift in the kitty modifier field', () => {
    expect(resolveKitty(event({ key: '∏', code: 'KeyP', altKey: true, shiftKey: true }))).toEqual({
      type: 'sendInput',
      data: '\x1b[112;4u'
    })
  })

  it('encodes Option+digit and mapped Option+punctuation', () => {
    expect(resolveKitty(event({ key: '¡', code: 'Digit1', altKey: true }))).toEqual({
      type: 'sendInput',
      data: '\x1b[49;3u'
    })
    expect(resolveKitty(event({ key: '≥', code: 'Period', altKey: true }))).toEqual({
      type: 'sendInput',
      data: '\x1b[46;3u'
    })
  })

  it('exempts dead keys so Option composition still starts', () => {
    expect(resolveKitty(event({ key: 'Dead', code: 'KeyE', altKey: true }))).toBeNull()
  })

  it('defers to xterm in macOptionAsAlt=true mode (native kitty encoding is correct there)', () => {
    expect(resolveKitty(event({ key: 'p', code: 'KeyP', altKey: true }), 'true')).toBeNull()
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
    // Meta-side Option in 'left' mode stays shift-exempt without kitty.
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
    // The B/F/D readline patches still apply without kitty.
    expect(
      resolveKitty(event({ key: '∫', code: 'KeyB', altKey: true }), 'false', 0, kittyInactive)
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
  })

  it('encodes the compose-side Option key as kitty CSI-u in left/right modes', () => {
    // In 'left' mode the right Option normally composes; a kitty pane asked
    // for modifier-accurate keys, so it gets alt-encoded too.
    expect(resolveKitty(event({ key: '¬', code: 'KeyL', altKey: true }), 'left', 2)).toEqual({
      type: 'sendInput',
      data: '\x1b[108;3u'
    })
    // The designated meta side upgrades from legacy Esc+letter to CSI-u.
    expect(resolveKitty(event({ key: '¬', code: 'KeyL', altKey: true }), 'left', 1)).toEqual({
      type: 'sendInput',
      data: '\x1b[108;3u'
    })
  })

  it('yields Alt+Arrow and Alt+Backspace to xterm kitty encoding', () => {
    expect(resolveKitty(event({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }))).toBeNull()
    expect(resolveKitty(event({ key: 'Backspace', code: 'Backspace', altKey: true }))).toBeNull()
    // Without kitty, the readline translations still apply.
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
      layoutBaseCharacterForCode: (code: string) => string | undefined
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
        layoutBaseCharacterForCode
      )

    // AZERTY types M at the physical Semicolon position; the layout map must
    // win over the US punctuation table so the chord reports alt+m, not alt+;.
    const azerty = (code: string): string | undefined => (code === 'Semicolon' ? 'm' : undefined)
    expect(resolveWithLayout(event({ key: 'µ', code: 'Semicolon', altKey: true }), azerty)).toEqual(
      { type: 'sendInput', data: '\x1b[109;3u' }
    )

    // Colemak types P at the physical KeyR position.
    const colemak = (code: string): string | undefined => (code === 'KeyR' ? 'p' : undefined)
    expect(resolveWithLayout(event({ key: 'π', code: 'KeyR', altKey: true }), colemak)).toEqual({
      type: 'sendInput',
      data: '\x1b[112;3u'
    })

    // Falls back to the US table when the layout map has no entry.
    const empty = (): string | undefined => undefined
    expect(resolveWithLayout(event({ key: 'π', code: 'KeyP', altKey: true }), empty)).toEqual({
      type: 'sendInput',
      data: '\x1b[112;3u'
    })
  })
})
