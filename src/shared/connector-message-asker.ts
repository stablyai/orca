import * as z from 'zod'
import {
  CONNECTOR_ASKER_PLACE_KINDS,
  ConnectorAskerVia,
  type ConnectorAsker
} from './connectors/connector-cloud-contract'
import { CONNECTOR_SOURCES, type ConnectorSource } from './connectors/external-conversation-link'

/** A message someone without access wrote in the thread, held until this one carried it. */
export type ConnectorNoAccessLine = { name?: string; text: string }

/** Who asked a bot and where, as stored on the journal message Orca delivered for them: the cloud's
 *  facts without the asker's words (the message has those), the source they came through, and the
 *  lines from people without access that arrived with it. */
export type ConnectorMessageAsker = Pick<
  ConnectorAsker,
  'userId' | 'name' | 'role' | 'place' | 'url' | 'avatarUrl' | 'messageRef' | 'via'
> & { source: ConnectorSource; noAccess?: ConnectorNoAccessLine[] }

/** The part of a delivered asker the journal keeps, with only links a tag may open or fetch. */
export function storedConnectorAsker(
  source: ConnectorSource,
  { userId, name, role, place, url, avatarUrl, messageRef, context, via }: ConnectorAsker
): ConnectorMessageAsker | undefined {
  const noAccess = context.flatMap((item) =>
    item.kind === 'no_access' ? [{ name: item.name, text: item.text }] : []
  )
  return readConnectorMessageAsker({
    source,
    userId,
    name,
    role,
    place,
    url,
    avatarUrl,
    messageRef,
    ...(noAccess.length > 0 ? { noAccess } : {}),
    via
  })
}

// Where each source's own links and avatars live; anything else is dropped, never opened or fetched.
const LINK_HOSTS: Partial<Record<ConnectorSource, readonly string[]>> = {
  slack: ['app.slack.com'],
  github: ['github.com'],
  linear: ['linear.app']
}
const AVATAR_HOSTS = [
  '.slack-edge.com',
  'avatars.githubusercontent.com',
  'public.linear.app'
] as const

function httpsHostIn(value: string, hosts: readonly string[]): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return false
  }
  return hosts.some((host) =>
    host.startsWith('.') ? url.hostname.endsWith(host) : url.hostname === host
  )
}

export function isConnectorAskerLink(source: ConnectorSource, value: string): boolean {
  const hosts = LINK_HOSTS[source]
  return hosts !== undefined && httpsHostIn(value, hosts)
}

export function isConnectorAvatarUrl(value: string): boolean {
  return httpsHostIn(value, AVATAR_HOSTS)
}

const MAX_URL_LENGTH = 2048
const optionalUrl = z.string().min(1).max(MAX_URL_LENGTH).optional().catch(undefined)

/** A connector person's picture, kept only from a host the avatar cache serves; anything else is
 *  dropped, not an error. */
export const optionalConnectorAvatarUrl = optionalUrl
  .refine((url) => url === undefined || isConnectorAvatarUrl(url))
  .catch(undefined)
// The cloud carries at most the newest 20 held lines, each capped well under this.
const MAX_NO_ACCESS_LINES = 20
const noAccessLine = z
  .object({
    name: z.string().min(1).max(200).optional().catch(undefined),
    text: z.string().min(1).max(8000)
  })
  .transform(({ name, text }): ConnectorNoAccessLine => ({
    ...(name ? { name } : {}),
    text
  }))

// Mirrors ConnectorAsker; a link or avatar this build can't trust drops that field, not the tag.
const askerSchema = z
  .object({
    source: z.enum(CONNECTOR_SOURCES),
    userId: z.string().min(1).max(128),
    name: z.string().min(1).max(200).optional().catch(undefined),
    role: z.enum(['owner', 'member']),
    place: z.object({
      kind: z.enum(CONNECTOR_ASKER_PLACE_KINDS),
      id: z.string().min(1).max(256)
    }),
    url: optionalUrl,
    avatarUrl: optionalUrl,
    messageRef: z.string().min(1).max(2048).optional().catch(undefined),
    via: ConnectorAskerVia,
    // Unreadable lines are left out one by one; the tag never depends on them.
    noAccess: z
      .array(z.unknown())
      .optional()
      .catch(undefined)
      .transform((lines) =>
        (lines ?? [])
          .slice(-MAX_NO_ACCESS_LINES)
          .flatMap((line) => noAccessLine.safeParse(line).data ?? [])
      )
  })
  .transform(({ url, avatarUrl, name, noAccess, messageRef, ...asker }): ConnectorMessageAsker => {
    return {
      ...asker,
      ...(name ? { name } : {}),
      ...(noAccess.length > 0 ? { noAccess } : {}),
      ...(url && isConnectorAskerLink(asker.source, url) ? { url } : {}),
      ...(avatarUrl && isConnectorAvatarUrl(avatarUrl) ? { avatarUrl } : {}),
      // Only a ref in the asker's own source, so it can't point a reaction anywhere else.
      ...(messageRef?.startsWith(`${asker.source}:`) ? { messageRef } : {})
    }
  })

/** The one reader of a stored or published `asker`: undefined when absent or unreadable, so a
 *  message from a newer host renders as it would without one. */
export function readConnectorMessageAsker(value: unknown): ConnectorMessageAsker | undefined {
  if (value === undefined) {
    return undefined
  }
  const parsed = askerSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
