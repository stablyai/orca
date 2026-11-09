// Share links for an Orca Cloud workspace port (cloud/apps/sandbox-control/src/share-links.ts).
// The Worker's tests parse its share responses with these schemas.
import { z } from 'zod'

export const SHARE_AUDIENCES = ['team', 'public'] as const
export type ShareAudience = (typeof SHARE_AUDIENCES)[number]
export const SHARE_EXPIRIES = ['1h', '24h', '7d'] as const
export type ShareExpiry = (typeof SHARE_EXPIRIES)[number]
export type ShareState = 'active' | 'expired' | 'revoked'

const Millis = z.number().int().nonnegative()

export const ShareLinkSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{32}$/),
    sandboxId: z.string().min(1).max(128),
    port: z.number().int().min(1).max(65535),
    audience: z.enum(SHARE_AUDIENCES),
    allowWake: z.boolean(),
    url: z.url({ protocol: /^https$/ }).max(2048),
    state: z.enum(['active', 'expired', 'revoked']),
    createdBy: z.string().min(1).max(128),
    createdAt: Millis,
    expiresAt: Millis,
    revokedAt: Millis.nullable()
  })
  .strict()
export type ShareLink = z.infer<typeof ShareLinkSchema>

export const ShareLinkResponseSchema = z.object({ share: ShareLinkSchema }).strict()
export const ShareLinkListResponseSchema = z.object({ shares: z.array(ShareLinkSchema) }).strict()
export const ShareVisitResponseSchema = z
  .object({ url: z.url({ protocol: /^https$/ }).max(4096) })
  .strict()

export type ShareCreateRequest = {
  port: number
  audience: ShareAudience
  expiresIn: ShareExpiry
  allowWake: boolean
}

export const CLOUD_SHARE_CHANNELS = {
  list: 'cloudShares:list',
  create: 'cloudShares:create',
  revoke: 'cloudShares:revoke',
  open: 'cloudShares:open'
} as const

/** `orca://cloud-share/<token>`: the team-only interstitial's "Open in Orca" link. */
export function parseCloudShareDeepLink(url: string): string | null {
  return /^orca:\/\/cloud-share\/([0-9a-f]{52})\/?$/.exec(url.trim())?.[1] ?? null
}

/** Ports the control plane reserves (sshd, orcad, the share proxy); they can't be shared. */
export const SHARE_RESERVED_PORTS: readonly number[] = [2222, 6768, 6769]

export type CloudShareFailureCode =
  | 'not_cloud'
  | 'unavailable'
  | 'unauthorized'
  | 'not_found'
  | 'limit'
  | 'invalid_request'

export type CloudShareResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: CloudShareFailureCode; message: string }
