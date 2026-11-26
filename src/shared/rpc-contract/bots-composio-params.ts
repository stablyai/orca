// `bots.composio.*`: a bot's Composio apps, read and connected by Orca with the owner's key.
import * as z from 'zod'
import { ComposioSetupAppSchema } from '../composio/composio-setup-card'

const Text = (max: number) => z.string().trim().min(1).max(max)
const BotId = Text(200)
/** Composio's app slugs are lower-case words joined by _ or -. */
const AppSlug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/, 'Name an app by its Composio slug')

export const ComposioBot = z.object({ botId: BotId })
/** The key from the owner's dialog; a setup card's dialog names its bot and app, so the chat moves on. */
export const ComposioSetKey = z.object({
  key: Text(512),
  botId: BotId.optional(),
  app: ComposioSetupAppSchema.optional()
})
export const ComposioApps = z.object({
  botId: BotId,
  search: z.string().trim().max(100).optional(),
  cursor: z.string().max(200).optional()
})
export const ComposioApp = z.object({ botId: BotId, app: AppSlug })
/** `card`: a chat setup card's Connect, whose end the chat shows and, unless the card was an
 *  expiry's, the bot hears. */
export const ComposioConnect = ComposioApp.extend({
  card: z.object({ name: Text(100), reason: z.literal('expired').optional() }).optional()
})
export const ComposioDisconnect = z.object({ botId: BotId, accountId: Text(200) })

/** Where the owner started a setup from, for the chat's first line. */
export const COMPOSIO_SETUP_STARTED_FROM = ['add-connector', 'tools'] as const
export const ComposioStartSetup = z.object({
  botId: BotId,
  from: z.enum(COMPOSIO_SETUP_STARTED_FROM),
  app: ComposioSetupAppSchema.optional()
})
/** A bot asks for its next setup card from its chat. */
export const ComposioSetupCard = z.object({
  callerSessionId: Text(200).optional(),
  botId: BotId.optional(),
  app: AppSlug.optional(),
  name: Text(100).optional()
})
export const ComposioKeyDeclined = z.object({ botId: BotId })

const HookId = Text(200)
const TriggerSlug = z.string().regex(/^[A-Z0-9_]{1,120}$/, 'Name the trigger by its Composio slug')
/** A bot asks for the card that sends a trigger's events to one of its webhooks. */
/** Remove key; `alsoEvents` turns off every bot's triggers and the project's events too. */
export const ComposioRemoveKey = z.object({ alsoEvents: z.boolean().optional() }).nullish()

export const ComposioEventsCard = z.object({
  callerSessionId: Text(200).optional(),
  botId: BotId.optional(),
  hookId: HookId,
  trigger: TriggerSlug,
  /** The trigger's settings, as JSON. */
  config: z.string().max(2000).optional()
})
export const ComposioEventsStatus = z.object({ botId: BotId, hookId: HookId, trigger: TriggerSlug })
export const ComposioEventsSetUp = ComposioEventsStatus.extend({
  config: z.string().max(2000).optional(),
  replace: z.boolean().optional(),
  /** The by-hand steps' Done, with the events hook they showed. */
  byHand: HookId.optional()
})
export const ComposioEventsByHand = z.object({ botId: BotId, hookId: HookId })
