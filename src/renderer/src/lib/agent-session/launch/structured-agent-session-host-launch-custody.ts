/** Who holds a host launch's held message once the host has answered. Only the host's receipt for
 *  the text lets this window let go of it; a chat or terminal existing says nothing about the text. */

import type { AgentLaunchResult } from '../../../../../shared/agent-launch/contracts/agent-launch-intent'
import { returnedMessageContribution } from '@/components/native-chat/structured-agent-session-message-hand-back'
import {
  adoptIdentifiedNativeChatDraftInput,
  nativeChatDraftHasReceipt,
  requestNativeChatDraftReceiptCommit
} from '@/components/native-chat/native-chat-composer-draft-handback'
import { holdHostLaunchHandback } from './structured-agent-session-host-launch-handback'
import type { StructuredAgentSessionLaunchIntent } from '../../launch-structured-agent-session'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import {
  hasStagedStructuredLaunchPrompt,
  settleHeldStructuredLaunchPrompts,
  settleHostCarriedStructuredLaunchPrompts,
  takeBackLegacyStructuredLaunchPrompts
} from './structured-agent-session-launch-prompt'
import { retireHostLaunchSources } from './structured-agent-session-host-launch-sources'
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
 *  again from here. The return is identified by the launch and message: it joins the draft once,
 *  whatever is typed or removed after, and the launch lets go of the opening (and of its client
 *  files) only once that draft is durably saved. Until then the opening, its row and its files
 *  stay owed, and a later answer, Retry or reload tries again. */
export function releaseHostLaunchMessage(
  intent: StructuredAgentSessionLaunchIntent,
  acknowledged: boolean
): void {
  const opening = intent.hostLaunch ? intent.opening : undefined
  if (acknowledged) {
    settleHeldStructuredLaunchPrompts(intent.sessionId, true)
    settleHostCarriedStructuredLaunchPrompts(intent.sessionId)
    retireHostLaunchSources(intent)
  } else if (opening && intent.hostLaunch) {
    const scope = structuredAgentSessionDraftScopeKey(intent.sessionId)
    const receipt = {
      operationId: intent.hostLaunch.operationId,
      clientMessageId: opening.clientMessageId
    }
    if (!nativeChatDraftHasReceipt(scope, receipt)) {
      // Files not yet on the host come back claimed by the draft too, beside the launch's own hold.
      intent.hostLaunch.sources?.transfer?.(scope)
      adoptIdentifiedNativeChatDraftInput(
        scope,
        receipt,
        returnedMessageContribution(
          `returned-${opening.clientMessageId}`,
          opening.body.blocks,
          undefined,
          undefined,
          opening.body.skills
        ),
        clientSourcePaths(intent)
      )
      settleHeldStructuredLaunchPrompts(intent.sessionId, false)
    }
    // The opening, its row and its files stay the launch's until the draft holds it durably; each
    // answer (a Retry's included) asks the draft to save it again if an earlier save was refused.
    requestNativeChatDraftReceiptCommit(scope, receipt)
    holdHostLaunchHandback(intent.sessionId, receipt)
    return
  } else if (hasStagedStructuredLaunchPrompt(intent.sessionId)) {
    takeBackLegacyStructuredLaunchPrompts(intent.sessionId)
  }
  if (opening) {
    delete intent.opening
    notifyStructuredLaunchIntentChanged(intent)
  }
}

/** The client files a first turn still being edited owes its host: they go back with it, still
 *  to be prepared before any send. A submitted turn's are already on the host. */
function clientSourcePaths(intent: StructuredAgentSessionLaunchIntent): readonly string[] {
  const firstTurn = intent.hostLaunch?.firstTurn
  return firstTurn?.phase === 'editing' ? (firstTurn.staged ?? []) : []
}
