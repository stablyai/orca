// Mirror of the turn end's pull request links in cloud/packages/connector-contract (event-messages).
import * as z from 'zod'
import { lazyZodSchema } from './schema/lazy-zod-schema'
import { CONNECTOR_CLIENT_LIMITS } from './connectors/connector-cloud-contract'

/** As many as a turn end carries. */
export const CONNECTOR_MAX_WORK_LINKS = 5

/** A pull request a conversation's work opened, for sources that show one beside the conversation;
 *  an enterprise host may be http. */
export const ConnectorWorkLink = lazyZodSchema(() =>
  z.object({
    url: z.url({ protocol: /^https?$/ }).max(2048),
    title: z.string().min(1).max(CONNECTOR_CLIENT_LIMITS.maxDisplayTextLength)
  })
)
export type ConnectorWorkLink = z.infer<typeof ConnectorWorkLink>
