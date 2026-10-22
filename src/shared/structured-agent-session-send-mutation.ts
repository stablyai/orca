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

/** What a send carries beside its message: both join the OPERATION fingerprint, never the body's. */
export type StructuredAgentSessionSendControl = {
  delivery?: 'queue-if-active'
  options?: Readonly<Record<string, string>>
  usageLimitContinuationOfTurnItemId?: string
}

export type StructuredAgentSessionSendMutation = StructuredAgentSessionSendControl & {
  envelope: AgentSessionMutationEnvelope
  body: AgentJournalMessageItem
}

/** The control fields a send names, as the client sends them and the host digests them. */
export function agentSessionSendControlFields(
  send: StructuredAgentSessionSendControl
): StructuredAgentSessionSendControl {
  return {
    ...(send.delivery ? { delivery: send.delivery } : {}),
    ...(send.options ? { options: send.options } : {}),
    ...(send.usageLimitContinuationOfTurnItemId
      ? { usageLimitContinuationOfTurnItemId: send.usageLimitContinuationOfTurnItemId }
      : {})
  }
}

/** What a send's operation fingerprint covers, on the client and the host alike. */
export function agentSessionSendFields(
  send: StructuredAgentSessionSendControl & { body: AgentJournalMessageItem }
): StructuredAgentSessionSendControl & { body: AgentJournalMessageItem } {
  return { body: agentSessionMessagePayload(send.body), ...agentSessionSendControlFields(send) }
}

/** What every send fingerprint covers: the message without its sender, which never reaches the
 *  provider, so its echo still matches. A body with no sender hashes exactly as it always has. */
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

/** The `agentSession.send` arguments for one message. Typed rather than wire-shaped so a host
 *  calling its own send path builds the same envelope a client would, fingerprint included. */
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

/** The journal body for a message a person sends: its text, then its images, and the skills it
 *  picked whose `$name` the text still carries. */
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

/** The picked skills a message still names, once per file: an edit can delete a `$name`. */
export function pickedSkillsInText(
  text: string,
  skills: readonly AgentJournalSkillRef[]
): AgentJournalSkillRef[] {
  const seen = new Set<string>()
  return skills.filter((skill) => {
    if (seen.has(skill.path) || !textNamesSkill(text, skill.name)) {
      return false
    }
    seen.add(skill.path)
    return true
  })
}

function textNamesSkill(text: string, name: string): boolean {
  const token = `$${name}`
  for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
    // Ends where a skill name can't continue, as Codex reads a mention: `$review,` names `review`.
    if (!/[\w:-]/u.test(text.charAt(at + token.length))) {
      return true
    }
  }
  return false
}
