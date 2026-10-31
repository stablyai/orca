import { describe, expect, it } from 'vitest'
import {
  resolveTerminalShortcutAction,
  type TerminalShortcutEvent
} from './terminal-shortcut-policy'

function cmdArrow(key: 'ArrowLeft' | 'ArrowRight'): TerminalShortcutEvent {
  return {
    key,
    code: key,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false
  }
}

function resolveOnMac(key: 'ArrowLeft' | 'ArrowRight', kittyFlags: number) {
  return resolveTerminalShortcutAction(
    cmdArrow(key),
    true,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    () => kittyFlags
  )
}

describe('Cmd+←/→ line start/end on macOS', () => {
  it('sends readline Ctrl+A/Ctrl+E when the pane has no kitty keyboard flags', () => {
    expect(resolveOnMac('ArrowLeft', 0)).toEqual({ type: 'sendInput', data: '\x01' })
    expect(resolveOnMac('ArrowRight', 0)).toEqual({ type: 'sendInput', data: '\x05' })
  })

  it('sends Home/End when a kitty-protocol TUI owns the keyboard', () => {
    // DSH-TUI binds Ctrl+A/E to its subagent dashboard and show-all toggle, not line start/end.
    expect(resolveOnMac('ArrowLeft', 1)).toEqual({ type: 'sendInput', data: '\x1b[H' })
    expect(resolveOnMac('ArrowRight', 1)).toEqual({ type: 'sendInput', data: '\x1b[F' })
  })

  it('leaves Cmd+←/→ alone off macOS', () => {
    expect(
      resolveTerminalShortcutAction(
        cmdArrow('ArrowLeft'),
        false,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        () => 1
      )
    ).toBeNull()
  })
})
