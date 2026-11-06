/** Who holds a host launch's held message once the host has answered. Only the host's receipt for
 *  the text lets this window let go of it; a chat or terminal existing says nothing about the text. */

import type { AgentLaunchResult } from '../../../../../shared/agent-launch/contracts/agent-launch-intent'
import { handBackStructuredAgentSessionMessage } from '@/components/native-chat/structured-agent-session-message-hand-back'
import type { StructuredAgentSessionLaunchIntent } from '../../launch-structured-agent-session'
import {
  hasStagedStructuredLaunchPrompt,
  settleHostCarriedStructuredLaunchPrompts,
  takeBackLegacyStructuredLaunchPrompts
} from './structured-agent-session-launch-prompt'
import { notifyStructuredLaunchIntentChanged } from './structured-agent-session-launch-registry'

/** The host has the text: founded as its chat's first message, delivered to its terminal, or
 *  carried by the terminal's own command. A draft left unsent, a text the plan gave the terminal
 *  none of, an unconfirmed send or another message's receipt leaves it the user's. */
export function hostLaunchMessageAcknowledged(
  intent: StructuredAgentSessionLaunchIntent,
  result: AgentLaunchResult
): boolean {
  const prompt = result.prompt
  return prompt?.outcome === 'journaled'
    ? !intent.opening || prompt.messageId === intent.opening.clientMessageId
    : prompt?.outcome === 'handed-to-terminal'
}

/** Settles the held message once: let go when the host acknowledged it, else back to the chat's
 *  composer beside whatever was typed there, and never sent again from here. Text staged in this
 *  window settles with its send; a launch restored after a reload has only its saved copy, which
 *  is kept until the composer durably holds it. */
export function releaseHostLaunchMessage(
  intent: StructuredAgentSessionLaunchIntent,
  acknowledged: boolean
): void {
  const saved = intent.hostLaunch ? intent.opening : undefined
  let settled = true
  if (acknowledged) {
    settleHostCarriedStructuredLaunchPrompts(intent.sessionId)
  } else if (hasStagedStructuredLaunchPrompt(intent.sessionId)) {
    settled = takeBackLegacyStructuredLaunchPrompts(intent.sessionId)
  } else if (saved) {
    settled = handBackStructuredAgentSessionMessage(
      intent.sessionId,
      saved.clientMessageId,
      saved.body
    )
  }
  if (saved && settled) {
    delete intent.opening
    // Its own row saved again without it, and only that row: a later reload has nothing left to
    // give back.
    notifyStructuredLaunchIntentChanged(intent)
  }
}
