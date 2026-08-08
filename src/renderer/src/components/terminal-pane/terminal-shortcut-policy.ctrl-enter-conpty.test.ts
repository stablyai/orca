// @vitest-environment happy-dom
/**
 * #12462 — Ctrl+Enter emitted `\x1b[13;5u` unconditionally, so a pane that never negotiated the
 * kitty keyboard protocol (local Windows ConPTY, plain shell) printed the escape verbatim into
 * the prompt instead of sending a newline.
 *
 * Kept out of `terminal-shortcut-policy.test.ts` because that file is at its `max-lines` ceiling
 * and suppressions are forbidden here.
 */
import { describe, expect, it } from 'vitest'

import {
  resolveTerminalShortcutAction,
  type TerminalShortcutEvent
} from './terminal-shortcut-policy'

function ctrlEnter(): TerminalShortcutEvent {
  return {
    key: 'Enter',
    code: 'Enter',
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    repeat: false
  }
}

/** Positional args up to the pane predicates the gate reads. */
function resolve(isLocalConpty: boolean, kittyActive?: boolean) {
  return resolveTerminalShortcutAction(
    ctrlEnter(),
    false,
    'false',
    0,
    true,
    undefined,
    () => isLocalConpty,
    kittyActive === undefined ? undefined : () => kittyActive
  )
}

describe('Ctrl+Enter on a pane that cannot receive CSI-u', () => {
  it('falls back to the legacy CR on a local ConPTY pane with no negotiation', () => {
    expect(resolve(true)).toEqual({ type: 'sendInput', data: '\r' })
  })

  it('sends the chord once that pane negotiates the protocol', () => {
    // The fallback is scoped to panes that cannot receive CSI-u, not to Windows.
    expect(resolve(true, true)).toEqual({ type: 'sendInput', data: '\x1b[13;5u' })
  })

  it('ordinary negative: a non-ConPTY pane keeps the chord', () => {
    expect(resolve(false)).toEqual({ type: 'sendInput', data: '\x1b[13;5u' })
  })
})
