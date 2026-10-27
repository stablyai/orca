import { describe, expect, it } from 'vitest'
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

describe('non-mac Ctrl+Left/Right word-nav', () => {
  // Readline needs Esc+b/f rather than xterm’s Ctrl+Arrow escapes on Linux/remote/WSL.
  it('translates Ctrl+←/→ on Linux to readline \\eb / \\ef', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true }),
        false
      )
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true }),
        false
      )
    ).toEqual({ type: 'sendInput', data: '\x1bf' })
  })

  // Local ConPTY/PSReadLine binds Ctrl+Arrow natively; Esc+b/f would self-insert stray letters.
  it('does NOT translate Ctrl+←/→ for a local Windows ConPTY pane', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true }),
        false,
        undefined,
        undefined,
        true,
        undefined,
        () => true
      )
    ).toBeNull()
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true }),
        false,
        undefined,
        undefined,
        true,
        undefined,
        () => true
      )
    ).toBeNull()
  })

  // Windows clients driving Linux/WSL still need readline encoding; host, not client, decides.
  it('still translates Ctrl+←/→ on Windows when the pane is not local ConPTY (SSH/WSL)', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true }),
        false,
        undefined,
        undefined,
        true,
        undefined,
        () => false
      )
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true }),
        false,
        undefined,
        undefined,
        true,
        undefined,
        () => false
      )
    ).toEqual({ type: 'sendInput', data: '\x1bf' })
  })

  it('does not translate Ctrl+Arrow on macOS (reserved by OS)', () => {
    // macOS reserves Ctrl+Arrow for Spaces; Cmd/Option handle line/word navigation.
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true }),
        true
      )
    ).toBeNull()
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true }),
        true
      )
    ).toBeNull()
  })

  it('does not intercept Ctrl+Shift+Arrow (selection passthrough)', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, shiftKey: true }),
        false
      )
    ).toBeNull()
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, shiftKey: true }),
        false
      )
    ).toBeNull()
  })

  it('does not intercept Ctrl+Alt+Arrow (different chord)', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, altKey: true }),
        false
      )
    ).toBeNull()
  })
})

describe('Alt+Left/Right on a local Windows ConPTY pane (#29177)', () => {
  const resolveOnWindows = (key: string, localConpty: boolean) =>
    resolveTerminalShortcutAction(
      event({ key, code: key, altKey: true }),
      false,
      undefined,
      undefined,
      true,
      undefined,
      () => localConpty
    )

  // ConPTY parses \eb/\ef into Alt+B/F key records, which Codex only treats as agent
  // switching on macOS and PSReadLine doesn't treat as Alt+←/→. Deferring lets xterm send
  // \e[1;3D/C, the form Windows Terminal sends and Git for Windows' inputrc binds to word-nav.
  it('defers to xterm so the pane receives the native Alt+arrow encoding', () => {
    expect(resolveOnWindows('ArrowLeft', true)).toBeNull()
    expect(resolveOnWindows('ArrowRight', true)).toBeNull()
  })

  it('still translates to readline word-nav on SSH/WSL panes', () => {
    expect(resolveOnWindows('ArrowLeft', false)).toEqual({ type: 'sendInput', data: '\x1bb' })
    expect(resolveOnWindows('ArrowRight', false)).toEqual({ type: 'sendInput', data: '\x1bf' })
  })
})
