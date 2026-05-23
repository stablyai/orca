import { describe, expect, it, vi } from 'vitest'

import {
  consumeHiddenTerminalHydration,
  markHiddenTerminalFallbackReplayed,
  queueHiddenTerminalOutput
} from './hidden-terminal-output-state'

function createTerminal() {
  return {
    write: vi.fn()
  }
}

describe('hidden terminal output state', () => {
  it('preserves reveal-time fallback output when trimming drops pre-hydration chunks', () => {
    const terminal = createTerminal()
    queueHiddenTerminalOutput(terminal, 'pty-1', 'before-reveal')
    const hydration = consumeHiddenTerminalHydration(terminal)
    expect(hydration).not.toBeNull()

    const retainedDuringHydration = 'x'.repeat(512 * 1024)
    queueHiddenTerminalOutput(terminal, 'pty-1', `dropped-prefix${retainedDuringHydration}`)

    expect(markHiddenTerminalFallbackReplayed(terminal, hydration!)).toBe(retainedDuringHydration)
  })
})
