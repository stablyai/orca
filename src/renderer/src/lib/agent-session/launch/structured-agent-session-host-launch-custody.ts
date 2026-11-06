/** Who holds a host launch's held message once the host has answered. Only the host's receipt for
 *  the text lets this window let go of it; a chat or terminal existing says nothing about the text. */

import type { AgentLaunchResult } from '../../../../../shared/agent-launch/contracts/agent-launch-intent'
import { handBackStructuredAgentSessionMessage } from '@/components/native-chat/structured-agent-session-message-hand-back'
import type { StructuredAgentSessionLaunchIntent } from '../../launch-structured-agent-session'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import {
  hasStagedStructuredLaunchPrompt,
  settleHeldStructuredLaunchPrompts,
  settleHostCarriedStructuredLaunchPrompts,
  takeBackLegacyStructuredLaunchPrompts
} from './structured-agent-session-launch-prompt'
import {
  handHostLaunchSourcesTo,
  retireHostLaunchSources
} from './structured-agent-session-host-launch-sources'
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

/** Settles the held opening once, from its current canonical form: let go when the host
 *  acknowledged it, else back to the chat's composer beside whatever was typed there, never sent
 *  again from here. Only a durable return ends this window's hold on it (and on its client
 *  files); one that could not be saved keeps the opening, its row and its files for a later try. */
export function releaseHostLaunchMessage(
  intent: StructuredAgentSessionLaunchIntent,
  acknowledged: boolean
): void {
  const opening = intent.hostLaunch ? intent.opening : undefined
  if (acknowledged) {
    settleHeldStructuredLaunchPrompts(intent.sessionId, true)
    settleHostCarriedStructuredLaunchPrompts(intent.sessionId)
    retireHostLaunchSources(intent)
  } else if (opening) {
    if (
      !handBackStructuredAgentSessionMessage(
        intent.sessionId,
        opening.clientMessageId,
        opening.body
      )
    ) {
      return
    }
    settleHeldStructuredLaunchPrompts(intent.sessionId, false)
    // Files not yet on the host go with the message: its draft keeps them from now.
    handHostLaunchSourcesTo(intent, structuredAgentSessionDraftScopeKey(intent.sessionId))
  } else if (hasStagedStructuredLaunchPrompt(intent.sessionId)) {
    takeBackLegacyStructuredLaunchPrompts(intent.sessionId)
  }
  if (opening) {
    delete intent.opening
    // Its own row saved again without it, and only that row: a later reload has nothing left to
    // give back.
    notifyStructuredLaunchIntentChanged(intent)
  }
}
