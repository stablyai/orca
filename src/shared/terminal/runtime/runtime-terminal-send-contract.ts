import type { WriteSettlement } from '../pty/lifecycle/pty-write-settlement'
import type { RuntimeTerminalWaitBlockedReason } from './runtime-terminal-contracts'

export type RuntimeTerminalSend = {
  handle: string
  accepted: boolean
  bytesWritten: number
  /** `input-changed`: the terminal took other input after the text `expectInputGeneration` names. */
  refusedReason?: 'no-agent' | 'permission' | 'approval-unseen' | 'input-changed'
  prompt?: RuntimeTerminalPromptDelivery
  writeSettlement?: WriteSettlement
  /** How long the client must wait before sending this text's Enter. Older hosts omit it. */
  submitDelayMs?: number
  /** Names this text as the terminal's last input; its Enter passes it back as
   *  `expectInputGeneration`. Older hosts omit it. */
  /** On an input-changed refusal, names the input now waiting instead. */
  inputGeneration?: number
}

/** Names one paste from one client window; `seq` only grows within a `lane`. */
export type RuntimeTerminalClientPaste = { lane: string; seq: number }

/** What the host knows of a client paste whose reply the client lost. `withdrawn`: it never
 *  arrived and now never will write; `refused`: it wrote nothing; `written`: some or all of it
 *  reached the terminal, and a later Enter or Ctrl+C past `inputGeneration` resolves it;
 *  `unknown`: the host can no longer tell. */
export type RuntimeTerminalClientPasteReceipt =
  | { state: 'withdrawn' | 'refused' | 'unknown' }
  | { state: 'writing'; settlesInMs: number }
  | { state: 'written'; inputGeneration: number; settlesInMs: number }

export type RuntimeTerminalPromptStage = 'input_accepted' | 'turn_started'

export type RuntimeTerminalPromptDelivery = {
  requestId: string
  stages: RuntimeTerminalPromptStage[]
  provider: 'antigravity' | 'claude' | 'codex' | 'unsupported' | 'old-host'
  observation: 'supported' | 'unsupported' | 'incarnation_replaced' | 'permission'
  processIncarnation: string
  generation: number
  baselineWorkingSequence: number
  /** Hook turn-start timestamp before this prompt was accepted. */
  baselineExplicitWorkingStartedAt?: number | null
  /** Permission observations seen before this prompt was accepted. */
  baselinePermissionSequence?: number
  /** When the paste and its Enter were written (epoch ms), for a start Orca never saw begin. */
  submit?: RuntimeTerminalPromptSubmit
}

export type RuntimeTerminalPromptSubmit = {
  pastedAt: number
  /** What ended the wait before Enter: screen quiet, the exact paste in the composer, or the cap. */
  renderWait?: 'quiet' | 'draft' | 'cap'
} & (
  | { enteredAt: number }
  /** What Enter would have answered or submitted after the paste, so Orca did not press it. */
  | { withheldFor: RuntimeTerminalPromptSubmitHold }
)

/** A dialog on screen, or input someone else typed into the terminal after the paste. */
export type RuntimeTerminalPromptSubmitHold = RuntimeTerminalWaitBlockedReason | 'terminal-input'
