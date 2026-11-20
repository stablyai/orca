import { agentSessionInteractionCommand } from '../../../../../../shared/agent-session/options/permissions/agent-session-interaction-mode'
import type { AgentJournalSkillRef } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { structuredAgentSessionBlocksTooLarge } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-message-params'
import { structuredAgentSessionSendBody } from '../../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { AGENT_SESSION_MESSAGE_TOO_LARGE_PARTS } from '../../../../../../shared/agent-session/failures/agent-session-refusal-notice'
import { agentSessionWriteNoticeText } from '../../messages/notices/agent-session-write-notice-text'
import { imageReferencesToPromptMarkers } from '../../../../../../shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import type { StructuredAgentSessionCommandOutcome } from '../../../../../../shared/agent-session/view/structured-agent-session-composer'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'
import type { NativeChatComposerImageAttachment } from '../../attachments/chips/native-chat-image-attachment'
import type { StructuredAgentSessionSendRequest } from '../../session/structured/delivery/structured-agent-session-send-slot'
import {
  withNativeChatAuxiliaryReferences,
  type NativeChatAuxiliaryReference
} from '../../selection-quotes/native-chat-auxiliary-references'

export type NativeChatStructuredComposerDispatch = Omit<
  StructuredAgentSessionCommandOutcome,
  'handled'
> & {
  revealsTranscript: boolean
  /** The accepted message carried selections; only then does the composer forget them. */
  auxiliaryReferencesApplied: boolean
}

export async function dispatchNativeChatStructuredComposerText(
  transport: NativeChatStructuredComposerTransport,
  draftText: string,
  attachments: readonly NativeChatComposerImageAttachment[] = [],
  skills: readonly AgentJournalSkillRef[] = [],
  intent: Pick<
    StructuredAgentSessionSendRequest,
    'alternate' | 'prepareAttachments' | 'onSettled'
  > = {},
  onPending?: () => void,
  auxiliaryReferences: readonly NativeChatAuxiliaryReference[] = []
): Promise<NativeChatStructuredComposerDispatch> {
  // Number image chips by their attachment order in this message.
  const prompt = imageReferencesToPromptMarkers(
    draftText,
    attachments.map((attachment) => attachment.id)
  )
  const pickedModeSkill =
    agentSessionInteractionCommand('codex', prompt) !== null &&
    skills.some((skill) => prompt.trimEnd() === `/${skill.name}`)
  // A sent command releases the draft now, as a pending message does; a refusal hands it back.
  const { handled, ...command } = pickedModeSkill
    ? { handled: false, accepted: false, error: null }
    : await transport.dispatchCommand(prompt, onPending)
  // Commands already reveal at keypress; messages reveal unless admitted as queued cards.
  if (handled) {
    return { ...command, revealsTranscript: false, auxiliaryReferencesApplied: false }
  }
  // The composer still owns its draft until admission, so refusal must precede the handoff.
  const promptWithReferences = withNativeChatAuxiliaryReferences(prompt, auxiliaryReferences)
  if (
    auxiliaryReferences.length > 0 &&
    structuredAgentSessionBlocksTooLarge(
      structuredAgentSessionSendBody(
        promptWithReferences,
        attachments.map(({ path }) => ({ path, previewUri: '' }))
      ).blocks
    )
  ) {
    return {
      accepted: false,
      error: agentSessionWriteNoticeText([...AGENT_SESSION_MESSAGE_TOO_LARGE_PARTS]),
      revealsTranscript: false,
      auxiliaryReferencesApplied: false
    }
  }
  const request = { ...(skills.length > 0 ? { skills } : {}), ...intent }
  const admission =
    Object.keys(request).length > 0
      ? transport.send(promptWithReferences, attachments, request)
      : transport.send(promptWithReferences, attachments)
  if (admission instanceof Promise) {
    onPending?.()
  }
  const accepted = await admission
  return {
    accepted: accepted !== false,
    error: null,
    revealsTranscript: accepted === true,
    auxiliaryReferencesApplied: auxiliaryReferences.length > 0
  }
}
