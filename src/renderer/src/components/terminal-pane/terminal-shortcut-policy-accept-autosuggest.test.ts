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

describe('resolveTerminalShortcutAction — accept autosuggest', () => {
  it('returns acceptAutosuggest for a bare RightArrow when a suggestion is active', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight' }),
        false,
        'false',
        0,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => false,
        () => true
      )
    ).toEqual({ type: 'acceptAutosuggest' })
  })

  it('returns acceptAutosuggest for a bare End when a suggestion is active', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'End' }),
        false,
        'false',
        0,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => false,
        () => true
      )
    ).toEqual({ type: 'acceptAutosuggest' })
  })

  it('returns null for a bare RightArrow when no suggestion is active', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight' }),
        false,
        'false',
        0,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => false,
        () => false
      )
    ).toBeNull()
  })

  it('does not intercept RightArrow with a modifier held, even with an active suggestion', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight', altKey: true }),
        false,
        'false',
        0,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => false,
        () => true
      )
    ).not.toEqual({ type: 'acceptAutosuggest' })
  })

  it('honors a rebound terminal.acceptAutosuggest keybinding over the old default', () => {
    // Why: proves the check routes through keybindingMatchesAction rather than
    // a hardcoded ArrowRight/End check — a Settings rebind must take effect.
    const overrides = { 'terminal.acceptAutosuggest': ['Tab'] }

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight' }),
        false,
        'false',
        0,
        false,
        overrides,
        undefined,
        undefined,
        undefined,
        undefined,
        () => false,
        () => true
      )
    ).not.toEqual({ type: 'acceptAutosuggest' })

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Tab' }),
        false,
        'false',
        0,
        false,
        overrides,
        undefined,
        undefined,
        undefined,
        undefined,
        () => false,
        () => true
      )
    ).toEqual({ type: 'acceptAutosuggest' })
  })
})
