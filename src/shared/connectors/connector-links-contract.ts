// The Orca account's linked Slack, GitHub and Linear people (mirror of the cloud contract's
// connector-endpoints.ts): GET `CONNECTOR_PATHS.links` lists them, DELETE one unlinks it.
import * as z from 'zod'

/** A cloud from before linked accounts has no route, so the page has nothing to show. */
export const CONNECTOR_LINKS_OFF = 'links_off'

// A source a newer cloud adds is skipped, not refused.
export const CONNECTOR_LINK_SOURCES = ['slack', 'github', 'linear'] as const
export type ConnectorLinkSource = (typeof CONNECTOR_LINK_SOURCES)[number]

export const ConnectorLinkSchema = z.object({
  source: z.enum(CONNECTOR_LINK_SOURCES),
  // 'github.com' for GitHub, whose people are not in a workspace.
  workspaceId: z.string().min(1),
  // '' for GitHub.
  workspaceName: z.string(),
  userId: z.string().min(1),
  // The GitHub login, or the person's display name in Slack or Linear.
  name: z.string(),
  linkedAt: z.number().int().nonnegative()
})

// Several per source, oldest first in each.
export const ConnectorLinksResponseSchema = z.object({
  links: z
    .array(z.unknown())
    .transform((links) => links.flatMap((link) => ConnectorLinkSchema.safeParse(link).data ?? []))
})

export type ConnectorLink = z.infer<typeof ConnectorLinkSchema>
export type ConnectorLinksResponse = z.infer<typeof ConnectorLinksResponseSchema>
/** Names one link, for unlinking it. */
export type ConnectorLinkKey = Pick<ConnectorLink, 'source' | 'workspaceId' | 'userId'>
