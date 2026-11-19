// A Composio setup card in a bot's chat. Orca writes it; the card draws from the host's Composio
// state (the key and the bot's sign-ins), so it updates on every client. Older clients and the phone
// paint its `text` as a plain line.
import * as z from 'zod'
import type {
  AgentJournalItemBody,
  AgentJournalPlainStatusItem
} from '../agent-session/journal/agent-session-journal-types'

export const COMPOSIO_SETUP_CARD_PRESENTATION = 'composio-setup'

/**
 * - `key`: add the owner's Composio key.
 * - `connect`: sign in to one app through Composio.
 * - `ready`: what the bot can now use.
 * - `events`: have Composio send a trigger's events to one of the bot's webhooks.
 */
export const COMPOSIO_SETUP_CARD_KINDS = ['key', 'connect', 'ready', 'events'] as const
export type ComposioSetupCardKind = (typeof COMPOSIO_SETUP_CARD_KINDS)[number]

export const ComposioSetupAppSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/),
  name: z.string().trim().min(1).max(100)
})
export type ComposioSetupApp = z.infer<typeof ComposioSetupAppSchema>

export const ComposioSetupCardRefSchema = z.object({
  botId: z.string().min(1).max(200),
  card: z.enum(COMPOSIO_SETUP_CARD_KINDS),
  /** The app the setup is for; a `key` card started with no app has none. */
  app: ComposioSetupAppSchema.optional(),
  /** An `events` card's webhook and Composio trigger, and the trigger's settings as JSON. */
  hookId: z.string().min(1).max(200).optional(),
  trigger: z
    .object({
      slug: z.string().regex(/^[A-Z0-9_]{1,120}$/),
      name: z.string().trim().min(1).max(200),
      config: z.string().max(2000).optional()
    })
    .optional(),
  /** `expired`: a `connect` card Orca put up because a sign-in expired, not because the bot asked;
   *  reconnecting from it tells only the owner. */
  reason: z.literal('expired').optional(),
  /** "Step 1 of 2"; absent when the card is the only step. */
  step: z.object({ index: z.number().int().min(1), total: z.number().int().min(2) }).optional()
})
export type ComposioSetupCardRef = z.infer<typeof ComposioSetupCardRefSchema>

function fallbackText(ref: ComposioSetupCardRef): string {
  const app = ref.app?.name
  switch (ref.card) {
    case 'key':
      return 'Composio setup: add your Composio key in Orca on your computer.'
    case 'connect':
      return `Composio setup: connect ${app ?? 'the app'} in Orca on your computer.`
    case 'ready':
      return app ? `${app} is connected through Composio.` : 'Composio is set up.'
    case 'events':
      return `Composio events: set up ${ref.trigger?.name ?? 'the trigger'} in Orca on your computer.`
  }
}

export function composioSetupCardBody(
  ref: ComposioSetupCardRef
): AgentJournalPlainStatusItem & { composioSetup: ComposioSetupCardRef } {
  return {
    kind: 'status',
    text: fallbackText(ref),
    presentation: COMPOSIO_SETUP_CARD_PRESENTATION,
    composioSetup: ref
  }
}

/** The card on a journal item, or null when it carries none or one this build can't read. */
export function composioSetupCardOf(body: AgentJournalItemBody): ComposioSetupCardRef | null {
  if (!('composioSetup' in body)) {
    return null
  }
  const parsed = ComposioSetupCardRefSchema.safeParse(body.composioSetup)
  return parsed.success ? parsed.data : null
}
