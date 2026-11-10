// Shared zod building blocks for the Orca Cloud /v1 wire types.
import { z } from 'zod'

export const CLOUD_API_SCOPES = [
  'workspaces:read',
  'workspaces:write',
  'messages:write',
  'projects:read',
  'projects:write',
  'routines:read',
  'routines:write',
  'audit:read'
] as const
export type CloudApiScope = (typeof CLOUD_API_SCOPES)[number]

/** Scopes only an org owner/admin may grant (personal accounts are their own admin). */
export const CLOUD_API_ADMIN_SCOPES: readonly CloudApiScope[] = ['audit:read']
export const CLOUD_API_READ_SCOPES: readonly CloudApiScope[] = [
  'workspaces:read',
  'projects:read',
  'routines:read'
]

export const Id = z.string().min(1).max(128)
// Server-provided links are opened in the browser: only ever https.
export const HttpsUrl = z.url({ protocol: /^https$/ }).max(2048)
export const Millis = z.number().int().nonnegative()
export const ShortText = z.string().max(500)
/** A teammate's display name when the control plane knows it (W4 member_names); null otherwise. */
// A malformed name degrades to null rather than failing the whole response.
export const PersonName = z.string().trim().max(200).nullable().optional().catch(null)
// Unknown scopes from a newer server are dropped rather than failing the whole list.
export const Scopes = z
  .array(z.string().max(64))
  .max(64)
  .transform((scopes) =>
    scopes.filter((scope): scope is CloudApiScope =>
      CLOUD_API_SCOPES.some((known) => known === scope)
    )
  )
