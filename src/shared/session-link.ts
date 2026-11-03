import { z } from 'zod'
import { isOrcaSessionId, type OrcaSessionId } from './orca-session-address'

export { SESSION_LINK_CAPABILITY } from './orchestration-runtime-capabilities'
export const SESSION_LINK_TURN_LIMIT = 6
export const SESSION_LINK_MESSAGE_LIMIT = 12
export const SESSION_LINK_MESSAGE_BYTES = 8 * 1024

const identifier = z.string().min(1).max(128)
const sessionId = identifier.pipe(
  z.custom<OrcaSessionId>((value) => typeof value === 'string' && isOrcaSessionId(value))
)
export const SessionLinkRole = z.enum(['reviewer', 'implementer'])
export const SessionLinkParticipant = z.object({
  sessionId,
  conversationId: sessionId,
  name: z.string().min(1).max(256),
  agent: z.enum(['claude', 'codex']),
  workspaceId: z.string().min(1).max(4096),
  directory: z.string().min(1).max(4096),
  branch: z.string().max(512),
  task: z.string().max(2048),
  context: z.string().max(256),
  role: SessionLinkRole
})
export type SessionLinkParticipant = z.infer<typeof SessionLinkParticipant>
export const SessionLink = z.object({
  id: identifier,
  story: z.string().trim().min(1).max(8192),
  participants: z.tuple([SessionLinkParticipant, SessionLinkParticipant]),
  state: z.enum(['active', 'paused', 'ended']),
  reason: z.string().max(512),
  version: z.number().int().positive(),
  turns: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type SessionLink = z.infer<typeof SessionLink>
export const SessionLinkMessageKind = z.enum([
  'introduction',
  'message',
  'question',
  'checkpoint',
  'reply',
  'owner-request',
  'owner-note'
])
export type SessionLinkMessageKind = z.infer<typeof SessionLinkMessageKind>
export const SessionLinkEvent = z.object({
  id: identifier,
  linkId: identifier,
  actor: z.string(),
  recipient: sessionId.nullable(),
  kind: z.enum(['control', ...SessionLinkMessageKind.options]),
  messageId: identifier.nullable(),
  replyTo: identifier.nullable(),
  state: z.enum(['recorded', 'queued', 'dispatching', 'accepted', 'blocked', 'cancelled']),
  operationId: z.string(),
  requestId: identifier.optional(),
  retryable: z.boolean().optional(),
  targetTurnId: identifier.optional(),
  createdAt: z.number(),
  detail: z.string(),
  body: z.string()
})
export type SessionLinkEvent = z.infer<typeof SessionLinkEvent>
export const SessionLinkSnapshot = z.object({
  link: SessionLink,
  events: z.array(SessionLinkEvent)
})
export type SessionLinkSnapshot = z.infer<typeof SessionLinkSnapshot>

export const LinkListParams = z.object({ sessionId }).strict()
export const LinkShowParams = z.object({ id: identifier }).strict()
export const LinkCreateParams = z
  .object({
    id: identifier,
    sessionId,
    partnerSessionId: sessionId,
    story: z.string().trim().min(1).max(8192),
    role: SessionLinkRole
  })
  .strict()
export const LinkControlParams = z
  .object({
    id: identifier,
    operationId: identifier,
    action: z.enum(['pause', 'resume', 'stop', 'end']),
    callerOperationId: identifier.optional(),
    version: z.number().int().positive()
  })
  .strict()
export const LinkResolveParams = z
  .object({
    id: identifier,
    eventId: identifier,
    operationId: identifier,
    version: z.number().int().positive()
  })
  .strict()
export type SessionLinkDeliveryResolution = z.infer<typeof LinkResolveParams>

export const LinkSendParams = z
  .object({
    id: identifier,
    operationId: identifier,
    body: z.string().trim().min(1).max(8192),
    kind: SessionLinkMessageKind.exclude(['introduction']),
    replyTo: identifier.optional()
  })
  .strict()
  .refine(
    (value) => value.kind !== 'reply' || value.replyTo !== undefined,
    'A reply must identify the partner message.'
  )

export function sessionLinkPartner(link: SessionLink, id: string): SessionLinkParticipant {
  const own = link.participants.find((p) => p.sessionId === id)
  const partner = link.participants.find((p) => p.sessionId !== id)
  if (!own || !partner) {
    throw new Error('This session is not a participant in this link.')
  }
  return partner
}
