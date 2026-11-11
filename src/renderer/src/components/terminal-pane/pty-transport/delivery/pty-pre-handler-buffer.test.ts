import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bufferPreHandlerPtyExit,
  clearPreHandlerPtyState,
  currentPreHandlerPtySequence,
  drainPreHandlerPtyExit,
  discardPreHandlerPtyExitFromForeignIncarnation,
  discardPreHandlerPtyStateFromPriorIncarnation,
  hasPreHandlerPtyExit
} from './pty-pre-handler-buffer'

const RECYCLED_PTY_ID = 'ssh:target@@pty-2'
// Model two lifetimes of one recycled relay ID: the old exited shell and its fresh replacement.
const PRIOR_INCARNATION_ID = 'incarnation-before-the-relay-restarted'
const FRESH_INCARNATION_ID = 'incarnation-of-the-shell-now-attaching'

describe('pre-handler PTY buffer', () => {
  afterEach(() => {
    clearPreHandlerPtyState(RECYCLED_PTY_ID)
  })

  // Keep separate exits when a newborn dies before attach and the prior owner’s exit arrives later; single-slot overwrite would lose the real death.
  it("keeps our own pre-attach exit when a late stranger's exit lands on the same recycled id", () => {
    const fence = currentPreHandlerPtySequence()
    bufferPreHandlerPtyExit(RECYCLED_PTY_ID, 1, FRESH_INCARNATION_ID)
    bufferPreHandlerPtyExit(RECYCLED_PTY_ID, 0, PRIOR_INCARNATION_ID)

    discardPreHandlerPtyExitFromForeignIncarnation(RECYCLED_PTY_ID, FRESH_INCARNATION_ID)
    discardPreHandlerPtyStateFromPriorIncarnation(RECYCLED_PTY_ID, fence)

    const exit = vi.fn()
    expect(hasPreHandlerPtyExit(RECYCLED_PTY_ID)).toBe(true)
    drainPreHandlerPtyExit(RECYCLED_PTY_ID, exit)
    expect(exit).toHaveBeenCalledWith(1, FRESH_INCARNATION_ID)
  })
})
