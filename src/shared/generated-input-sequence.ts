import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_CONFIG, type DraftPasteReadySignal } from './tui-agent-config'
import { resolvePasteReadySignal } from './draft-paste-ready-scanner'
import { AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS } from './agent-prompt-injection'
import { signalAllowsCompatibilityEvidence } from './generated-agent-input-readiness'

// The checks before Enter end early enough for Enter's own check and write to land in the budget.
export const ENTER_COMMIT_MARGIN_MS = 50

/** What one committed sequence's target decides: its agent, readiness rules, framing and the time
 *  its Enter needs. Derived from the target the queue turn finally selected, then pinned. */
export type GeneratedInputSequence = {
  agent: TuiAgent | null
  readySignal: DraftPasteReadySignal
  permitsQuiet: boolean
  /** The text frame itself carries Enter (agents that lose a separate Enter). */
  carriesEnter: boolean
  /** Time the settle wait and Enter need after the text, reserved before the text is written. */
  enterReserveMs: number
}

export function generatedInputSequence(
  agent: TuiAgent | null,
  submit: boolean,
  target: { textCarriesEnter?: boolean; enterReserveMs: number }
): GeneratedInputSequence {
  const readySignal = resolvePasteReadySignal(agent ? TUI_AGENT_CONFIG[agent] : null, submit)
  const carriesEnter = submit && target.textCarriesEnter === true
  return {
    agent,
    readySignal,
    permitsQuiet: signalAllowsCompatibilityEvidence(readySignal),
    carriesEnter,
    enterReserveMs:
      submit && !carriesEnter
        ? target.enterReserveMs + AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS + ENTER_COMMIT_MARGIN_MS
        : 0
  }
}
