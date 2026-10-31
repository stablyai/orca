import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalSkillRef
} from './agent-session-journal-types'
import type { AgentSessionMutationEnvelope } from './agent-session-wire'
import type { z } from 'zod'
import {
  MAX_SKILL_REFS,
  type SendBody
} from './rpc-contract/structured-agent-session-message-params'
import { structuredAgentSessionPayloadFingerprint } from './structured-agent-session-mutation'

/** Control fields affect the operation fingerprint, never the body hash used for provider echoes. */
export type StructuredAgentSessionSendControl = {
  delivery?: 'queue-if-active'
  options?: Readonly<Record<string, string>>
  selection?: Readonly<Record<string, string>>
  usageLimitContinuationOfTurnItemId?: string
}

export type StructuredAgentSessionSendMutation = StructuredAgentSessionSendControl & {
  envelope: AgentSessionMutationEnvelope
  body: AgentJournalMessageItem
}

export function agentSessionSendControlFields(
  send: StructuredAgentSessionSendControl
): StructuredAgentSessionSendControl {
  return {
    ...(send.delivery ? { delivery: send.delivery } : {}),
    ...(send.options ? { options: send.options } : {}),
    ...(send.selection !== undefined ? { selection: send.selection } : {}),
    ...(send.usageLimitContinuationOfTurnItemId
      ? { usageLimitContinuationOfTurnItemId: send.usageLimitContinuationOfTurnItemId }
      : {})
  }
}

export function agentSessionSendFields(
  send: StructuredAgentSessionSendControl & { body: AgentJournalMessageItem }
): StructuredAgentSessionSendControl & { body: AgentJournalMessageItem } {
  return { body: agentSessionMessagePayload(send.body), ...agentSessionSendControlFields(send) }
}

/** Exclude sender metadata because the provider never receives it; preserve body hashes for legacy messages and echo matching. */
export function agentSessionMessagePayload(body: AgentJournalMessageItem): AgentJournalMessageItem {
  const { from: _sender, ...payload } = body
  return payload
}

/** The body-only hash a submission and a queued draft store, and a provider echo is matched by. */
export function agentSessionSendBodyFingerprint(
  sessionId: string,
  body: AgentJournalItemBody
): string {
  return structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId,
    fields: { body: body.kind === 'message' ? agentSessionMessagePayload(body) : body }
  })
}

/** Host-owned sends use the same typed envelope/fingerprint as clients. */
export function structuredAgentSessionMessageSendMutation(
  message: {
    sessionId: string
    clientOperationId: string
    expectedRuntimeFence: number
    body: AgentJournalMessageItem
  } & StructuredAgentSessionSendControl
): StructuredAgentSessionSendMutation {
  const control = agentSessionSendControlFields(message)
  return {
    envelope: {
      sessionId: message.sessionId,
      clientOperationId: message.clientOperationId,
      expectedRuntimeFence: message.expectedRuntimeFence,
      payloadFingerprint: structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: message.sessionId,
        fields: agentSessionSendFields(message)
      })
    },
    body: message.body,
    ...control
  }
}

export type StructuredAgentSessionAttachment = {
  path: string
  previewUri: string
  /** The SSH connection a remote image lives on; kept by the client, never sent. */
  connectionId?: string
}

export class SkillRefLimitError extends Error {}

/** Text then images, retaining only picked skills still mentioned by $name. */
export function structuredAgentSessionSendBody(
  text: string,
  attachments: readonly StructuredAgentSessionAttachment[],
  skills: readonly AgentJournalSkillRef[] = []
): z.infer<typeof SendBody> {
  const picked = pickedSkillsInText(text, skills)
  if (picked.length > MAX_SKILL_REFS) {
    throw new SkillRefLimitError()
  }
  return {
    kind: 'message',
    role: 'user',
    blocks: [
      ...(text.trim().length > 0 ? [{ type: 'text' as const, text: text.trimEnd() }] : []),
      ...attachments.map((attachment) => ({ type: 'image-ref' as const, path: attachment.path }))
    ],
    ...(picked.length > 0 ? { skills: picked } : {})
  }
}

export function pickedSkillsInText(
  text: string,
  skills: readonly AgentJournalSkillRef[],
  sigils: readonly ('$' | '/')[] = ['$']
): AgentJournalSkillRef[] {
  const seen = new Set<string>()
  return skills.filter((skill) => {
    if (seen.has(skill.path) || !sigils.some((sigil) => textNamesSkill(text, skill.name, sigil))) {
      return false
    }
    seen.add(skill.path)
    return true
  })
}

function textNamesSkill(text: string, name: string, sigil: '$' | '/'): boolean {
  const token = `${sigil}${name}`
  for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
    // Match Codex mention boundaries: $review, ends at review.
    if (
      (sigil !== '/' || at === 0 || /\s/u.test(text.charAt(at - 1))) &&
      !/[\w:-]/u.test(text.charAt(at + token.length))
    ) {
      return true
    }
  }
  return false
}
