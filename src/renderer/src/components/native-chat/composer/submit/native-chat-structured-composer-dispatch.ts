import { agentSessionInteractionCommand } from '../../../../../../shared/agent-session/options/permissions/agent-session-interaction-mode'
import type { AgentJournalSkillRef } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { structuredAgentSessionBlocksTooLarge } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-message-params'
import { structuredAgentSessionSendBody } from '../../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { AGENT_SESSION_MESSAGE_TOO_LARGE_PARTS } from '../../../../../../shared/agent-session/failures/agent-session-refusal-notice'
import { agentSessionWriteNoticeText } from '../../messages/notices/agent-session-write-notice-text'
import { imageReferencesToPromptMarkers } from '../../../../../../shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import type { StructuredAgentSessionCommandOutcome } from '../../../../../../shared/agent-session/view/structured-agent-session-composer'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'
import { nativeChatBrowserFileReferences } from '../../attachments/native-chat-browser-file-references'
import { nativeChatBrowserFileRefusal } from '../../attachments/native-chat-browser-file-refusal'
import type { NativeChatComposerImageAttachment } from '../../attachments/chips/native-chat-image-attachment'
import type { StructuredAgentSessionSendRequest } from '../../session/structured/delivery/structured-agent-session-send-slot'

export async function dispatchNativeChatStructuredComposerText(
  transport: Pick<
    NativeChatStructuredComposerTransport,
    'dispatchCommand' | 'send' | 'attachmentStagingScope'
  > &
    Partial<Pick<NativeChatStructuredComposerTransport, 'sessionId'>>,
  draftText: string,
  attachments: readonly NativeChatComposerImageAttachment[] = [],
  skills: readonly AgentJournalSkillRef[] = [],
  intent: Pick<
    StructuredAgentSessionSendRequest,
    'alternate' | 'prepareAttachments' | 'onSettled'
  > = {},
  onPending?: () => void,
  /** The staged originals `intent.prepareAttachments` will map to host uploads; nothing else passes. */
  prepared: readonly string[] = []
): Promise<Omit<StructuredAgentSessionCommandOutcome, 'handled'> & { revealsTranscript: boolean }> {
  // Number image chips by their attachment order in this message.
  const prompt = imageReferencesToPromptMarkers(
    draftText,
    attachments.map((attachment) => attachment.id)
  )
  // Content naming a renderer-only browser file never leaves the renderer. Unless this send's own
  // preparation will turn it into a host upload (or a pending creation captures its first send), it is
  // refused here, before any command or send, while the composer still owns the draft: nothing is
  // handed back, so nothing can be merged into, or later erased from, the draft that still holds it.
  const preparable = new Set(intent.prepareAttachments ? prepared : [])
  const browserFiles = transport.attachmentStagingScope
    ? []
    : nativeChatBrowserFileReferences(prompt, attachments).filter(
        (reference) => !preparable.has(reference)
      )
  if (browserFiles.length > 0) {
    const parts = nativeChatBrowserFileRefusal(browserFiles, transport.sessionId)
    return {
      accepted: false,
      error: parts ? agentSessionWriteNoticeText(parts) : null,
      revealsTranscript: false
    }
  }
  const pickedModeSkill =
    agentSessionInteractionCommand('codex', prompt) !== null &&
    skills.some((skill) => prompt.trimEnd() === `/${skill.name}`)
  // A sent command releases the draft now, as a pending message does; a refusal hands it back.
  const { handled, ...command } = pickedModeSkill
    ? { handled: false, accepted: false, error: null }
    : await transport.dispatchCommand(prompt, onPending)
  // Commands already reveal at keypress; messages reveal unless admitted as queued cards.
  if (handled) {
    return { ...command, revealsTranscript: false }
  }
  // The composer still owns its draft until admission, so refusal must precede the handoff.
  const body = structuredAgentSessionSendBody(
    prompt,
    attachments.map(({ path }) => ({ path, previewUri: '' }))
  )
  if (structuredAgentSessionBlocksTooLarge(body.blocks)) {
    return {
      accepted: false,
      error: agentSessionWriteNoticeText([...AGENT_SESSION_MESSAGE_TOO_LARGE_PARTS]),
      revealsTranscript: false
    }
  }
  // A prepared send can still be refused locally once preparation settles (its custody moved). The
  // draft becomes the send's when the send is made, before that can happen, so a refusal is handed
  // back to a draft that no longer holds it, never merged into one whose cleanup is still pending.
  const request = {
    ...(skills.length > 0 ? { skills } : {}),
    ...intent,
    ...(intent.prepareAttachments && onPending ? { onCreated: () => onPending() } : {})
  }
  const admission =
    Object.keys(request).length > 0
      ? transport.send(prompt, attachments, request)
      : transport.send(prompt, attachments)
  if (admission instanceof Promise) {
    onPending?.()
  }
  const accepted = await admission
  return { accepted: accepted !== false, error: null, revealsTranscript: accepted === true }
}
