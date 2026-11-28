// What a teammate's invite shows of a shared agent besides its name and purpose: its mascot as its owner
// dressed it, and the services it uses besides Orca. It travels in the owner's hello and back on the
// teammate's share list (the connector contract's AgentCardSchema; copied, since the CLI compiles src/shared
// alone). Ids, not pictures: an uploaded picture stays on the owner's computer.
import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

const CardId = lazyZodSchema(() => z.string().min(1).max(32))

/** A card that doesn't parse is dropped, never the list or message carrying it. */
export const AgentCardSchema = lazyZodSchema(() =>
  z
    .object({
      mascot: CardId.optional(),
      color: CardId.optional(),
      outfit: CardId.optional(),
      services: z.array(CardId).max(8).optional()
    })
    .optional()
    .catch(undefined)
)
export type AgentCard = NonNullable<z.infer<typeof AgentCardSchema>>

/** The services a card names, in the order the invite lists them. */
export const AGENT_CARD_SERVICES = ['github', 'slack', 'linear', 'google'] as const
export type AgentCardService = (typeof AGENT_CARD_SERVICES)[number]
