import * as z from 'zod'
import { OptionalString, requiredString } from './rpc-param-primitives'

/** The bot run's token, so the host can refuse what a bot may not do; and its chat. */
const Caller = { botToken: OptionalString, callerSessionId: OptionalString }

const Guid = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Expected a GUID.')

/** A directory id, or its domain (contoso.onmicrosoft.com); never common or consumers. */
const Tenant = z.union([
  Guid,
  z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'Expected a tenant id or domain.')
])

export const TeamsStatusParams = z.object(Caller)

export const TeamsSignInStartParams = z.object({
  ...Caller,
  tenantId: Tenant,
  clientId: Guid,
  /** Only chats: leaves out the channel permissions, one of which needs an admin's consent. */
  chatsOnly: z.boolean().optional()
})

export const TeamsSignInFlowParams = z.object({ flowId: z.string().min(1).max(64) })

export const TeamsSignInWaitParams = TeamsSignInFlowParams.extend({
  afterRevision: z.number().int().nonnegative().default(0)
})

export const TeamsDisconnectParams = z.object(Caller)

export const TeamsBotSetParams = z.object({
  ...Caller,
  botId: requiredString('Missing bot id'),
  on: z.boolean()
})

export const TeamsFindParams = z.object({
  ...Caller,
  query: z.string().trim().min(1).max(2_048),
  limit: z.number().int().min(1).max(50).optional()
})

export const TeamsReadParams = z.object({
  ...Caller,
  ref: z.string().trim().min(1).max(2_048),
  limit: z.number().int().min(1).max(50).optional()
})

export const TeamsPostParams = z.object({
  ...Caller,
  ref: z.string().trim().min(1).max(2_048),
  // Teams takes about 28 KB of HTML per message.
  text: z.string().min(1).max(20_000)
})

export const TeamsReactParams = z.object({
  ...Caller,
  ref: z.string().trim().min(1).max(2_048),
  // One emoji, which may be several code points (a skin tone, a joined family).
  emoji: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .refine((value) => !/[\s<>&]/.test(value), 'Expected one emoji, like 👍.')
})
