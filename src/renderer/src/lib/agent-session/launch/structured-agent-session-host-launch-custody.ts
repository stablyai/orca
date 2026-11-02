/** Who holds a host launch's held message once the host has answered. Only the host's receipt for
 *  the text lets this window let go of it; a chat or terminal existing says nothing about the text. */

import type { AgentLaunchResult } from '../../../../../shared/agent-launch-intent'
import { handBackStructuredAgentSessionMessage } from '@/components/native-chat/structured-agent-session-message-hand-back'
import type { StructuredAgentSessionLaunchIntent } from '../../launch-structured-agent-session'
import {
  hasStagedStructuredLaunchPrompt,
  settleHostCarriedStructuredLaunchPrompts,
  takeBackLegacyStructuredLaunchPrompts
} from './structured-agent-session-launch-prompt'
import { notifyStructuredLaunchListeners } from './structured-agent-session-launch-registry'

/** The host has the text: founded as its chat's first message, delivered to its terminal, or
 *  carried by the terminal's own command. A draft left unsent, a text the plan gave the terminal
 *  none of, or an unconfirmed send is still the user's. */
export function hostLaunchMessageAcknowledged(result: AgentLaunchResult): boolean {
  const outcome = result.prompt?.outcome
  return outcome === 'journaled' || outcome === 'handed-to-terminal'
}

/** Settles the held message once: let go when the host acknowledged it, else back to the chat's
 *  composer beside whatever was typed there, and never sent again from here. Text staged in this
 *  window settles with its send; a launch restored after a reload has only its saved copy. */
export function releaseHostLaunchMessage(
  intent: StructuredAgentSessionLaunchIntent,
  acknowledged: boolean
): void {
  const saved = intent.hostLaunch?.firstMessage
  if (acknowledged) {
    settleHostCarriedStructuredLaunchPrompts(intent.sessionId)
  } else if (hasStagedStructuredLaunchPrompt(intent.sessionId)) {
    takeBackLegacyStructuredLaunchPrompts(intent.sessionId)
  } else if (saved) {
    handBackStructuredAgentSessionMessage(intent.sessionId, saved.clientMessageId, saved.body)
  }
  if (saved && intent.hostLaunch) {
    const { firstMessage: _settled, ...rest } = intent.hostLaunch
    intent.hostLaunch = rest
    // Saved again without it: a later reload has nothing left to give back.
    notifyStructuredLaunchListeners()
  }
}
