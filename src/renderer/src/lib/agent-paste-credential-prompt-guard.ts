import { findCredentialPromptIndex } from '../../../shared/terminal-credential-prompt-detection'
import { readPtyVisibleScreenText } from '@/components/terminal-pane/pty-visible-screen-registry'

/**
 * Why a reason and not a bare `false`: the paste lane must never drop a user prompt silently,
 * and "the agent never became ready" and "a sign-in dialog owns the screen" want different
 * advice and different telemetry.
 */
export type AgentDraftDeliveryFailure = 'readiness-timeout' | 'credential-prompt'

/** Outcome of one bracketed-paste attempt. `credential-prompt` means nothing was written. */
export type AgentDraftPasteOutcome = 'delivered' | 'not-delivered' | 'credential-prompt'

/**
 * The renderer twin of the main-process `agent_prompt_blocked` fence.
 *
 * `window.api.pty.write` never reaches `writeTerminalAgentPrompt`, so the paste lane that backs
 * quick launch, submit-after-ready, work-item launch and folder-workspace startup had no
 * credential check at all: its only gate is DECSET 2004 plus render-quiet, which a TUI drawing
 * its OWN sign-in dialog satisfies perfectly. A prompt pasted there is submitted to an auth
 * provider as a credential attempt and echoed into the unredacted session transcript.
 *
 * Same detector, same input shape, same asymmetric bias as the main lane: a false negative
 * types the user's task into a credential field, a false positive only defers the paste until
 * the dialog is answered.
 */
export function isAgentPasteBlockedByCredentialPrompt(ptyId: string): boolean {
  const screen = readPtyVisibleScreenText(ptyId)
  if (screen === null) {
    // Why not refuse: an unmounted pane is absence of evidence, and refusing every paste whose
    // pane has not mounted yet would block ordinary launches. Runtime-routed writes still pass
    // the main-process fence.
    return false
  }
  // Why lowercased: `detectTerminalWaitBlockedReason` normalizes before it reaches this
  // detector, and the detector's prefix rules are written against that normalized form.
  return findCredentialPromptIndex(screen.toLowerCase()) !== null
}
