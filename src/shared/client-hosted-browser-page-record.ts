import { z } from 'zod'

/** Runtime owns durable page identity; a restarted client has no guests to adopt. Persist identity, committed metadata/profile and device only. New epochs mint live authority; executionHostKey includes process/boot fencing and must be re-resolved or placement fails browser_client_network_route_authority_mismatch. */
export type PersistedClientHostedBrowserPage = {
  /** Row-level schema version. A row naming a version this build does not know is dropped. */
  v: typeof CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION
  browserPageId: string
  workspaceId: string
  browserProfileId: string
  url: string
  title: string
  /** Use durable paired-device identity; browserHostClientId is re-minted per desktop process and cannot place pages after relaunch. */
  pairedDeviceId: string
  /** When the row was last written; the only input to never-returning-host expiry. */
  savedAt: number
}

/** Forbid live-authority fields at compile time so persisted generations can never be replayed as authority. */
type ForbiddenAuthorityField = Extract<
  keyof PersistedClientHostedBrowserPage,
  | 'browserHostClientId'
  | 'browserHostGeneration'
  | 'executionHostKey'
  | 'pageHostGeneration'
  | 'placement'
  | 'connectionId'
  | 'authorityEpoch'
  | 'authorityRuntimeId'
  | 'webContentsId'
>
const noPersistedAuthority: [ForbiddenAuthorityField] extends [never] ? true : never = true
void noPersistedAuthority

export const CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION = 1

/** How long a rehydrated row may sit unclaimed before a later start drops it instead of restoring it. */
export const CLIENT_HOSTED_BROWSER_PAGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** Refresh unchanged rows so expiry measures last hosted time rather than last URL/metadata change. */
export const CLIENT_HOSTED_BROWSER_PAGE_REFRESH_MS = 24 * 60 * 60 * 1000

const identity = z.string().min(1).max(256)

export const persistedClientHostedBrowserPageSchema: z.ZodType<PersistedClientHostedBrowserPage> =
  z.object({
    // Reject unknown row versions entirely; salvagingArray preserves valid siblings without partially trusting newer semantics.
    v: z.literal(CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION),
    browserPageId: identity,
    workspaceId: identity,
    browserProfileId: identity,
    url: z.string().max(8192),
    title: z.string().max(4096),
    pairedDeviceId: identity,
    savedAt: z.number().int().nonnegative()
  })
