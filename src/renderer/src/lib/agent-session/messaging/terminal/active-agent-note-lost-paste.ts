import { AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS as POST_PASTE_SUBMIT_DELAY_MS } from '../../../../../../shared/agent-launch/startup/agent-prompt-injection'
import type { WriteSettlement } from '../../../../../../shared/terminal/pty/lifecycle/pty-write-settlement'
import type { RuntimeTerminalClientPaste } from '../../../../../../shared/terminal/runtime/runtime-terminal-send-contract'
import type { TerminalAgentSendReadinessResult } from './active-agent-terminal-send-readiness'
import {
  nextClientPaste,
  type TerminalSendLane,
  type UnsentTerminalPaste
} from './active-agent-terminal-send-lane'

/** Marks the lane before a paste is requested: until its reply says otherwise, some of it may reach
 *  the terminal. `before` is what the lane held; it comes back only when nothing was written. */
export function holdPossiblePaste(
  lane: TerminalSendLane,
  before: UnsentTerminalPaste | undefined,
  awaitsUserEnter: boolean
): {
  clientPaste: RuntimeTerminalClientPaste
  refused: (settlement: WriteSettlement | undefined, carriedSettleMs: number) => void
  lost: (carriedSettleMs: number) => void
} {
  const clientPaste = nextClientPaste()
  const possible: UnsentTerminalPaste = {
    settlesAt: Date.now(),
    awaitsUserEnter,
    enterOutcome: 'not-sent',
    pasteOutcome: { clientPaste, before }
  }
  lane.setUnsentPaste(possible)
  // Losing the reply leaves the paste's outcome for the host's receipt to settle.
  const lost = (carriedSettleMs: number): void => {
    possible.settlesAt = Date.now() + POST_PASTE_SUBMIT_DELAY_MS + carriedSettleMs
  }
  return {
    clientPaste,
    lost,
    refused: (settlement, carriedSettleMs) => {
      if (settlement?.outcome === 'unverifiable' && settlement.bytesHandedToTransport) {
        lost(carriedSettleMs)
      } else {
        lane.setUnsentPaste(before)
      }
    }
  }
}

/** Settles a paste whose reply was lost, from the host's receipt in `readiness`. Returns how long
 *  to wait when that paste is still writing; nothing may be sent behind it until it finishes.
 *  A host without receipts leaves the paste awaiting deliberate resolution, as older hosts do. */
export function settleLostPaste(
  lane: TerminalSendLane,
  readiness: TerminalAgentSendReadinessResult
): number | undefined {
  const unsent = lane.unsentPaste()
  const receipt = readiness.clientPaste
  if (!unsent?.pasteOutcome || !receipt) {
    return undefined
  }
  const { pasteOutcome, ...paste } = unsent
  switch (receipt.state) {
    case 'withdrawn':
    case 'refused':
      // None of it reached the terminal: whatever was waiting before it still is.
      lane.setUnsentPaste(pasteOutcome.before)
      return undefined
    case 'writing':
      return Math.max(POST_PASTE_SUBMIT_DELAY_MS, receipt.settlesInMs)
    case 'written':
      // Some or all of it is in the input: only an Enter or Ctrl+C after it resolves it.
      lane.setUnsentPaste({
        ...paste,
        settlesAt: Date.now() + receipt.settlesInMs,
        inputGeneration: receipt.inputGeneration
      })
      return undefined
    case 'unknown':
      // The next settled readiness supplies a baseline later resolution must pass.
      lane.setUnsentPaste({ ...paste, inputGeneration: undefined })
      return undefined
  }
}
