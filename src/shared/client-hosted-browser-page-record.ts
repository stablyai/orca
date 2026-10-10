import { z } from 'zod'

/**
 * Durable form of a client-hosted logical page.
 *
 * The runtime owns the page identity; the paired desktop owns the engine that renders it. Losing
 * the runtime's record therefore loses the page for everyone, because no other participant can
 * name it: a restarted client's guests are gone too, so its inventory has nothing to adopt from.
 *
 * What is stored here is deliberately only what outlives an authority: identity, last committed
 * metadata, browser profile, and the durable device that hosted it. Live authority -- connection
 * ids, lease and page generations, WebContents ids -- is unrepresentable in this type on purpose.
 * Every runtime start mints a new authority epoch, so a persisted generation could only ever be a
 * forgery of one.
 *
 * `executionHostKey` is absent for the same reason even though it reads like a durable address:
 * it is the route FENCING key, and its native and WSL forms name the runtime's per-process id and
 * boot time. A client asked to place a page under a predecessor's key answers
 * `browser_client_network_route_authority_mismatch`, so recovery re-resolves the workspace's
 * current key rather than replaying this one.
 */
export type PersistedClientHostedBrowserPage = {
  /** Row-level schema version. A row naming a version this build does not know is dropped. */
  v: typeof CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION
  browserPageId: string
  workspaceId: string
  browserProfileId: string
  url: string
  title: string
  /**
   * Preferred placement: the durable paired device that hosted the page. Deliberately not
   * `browserHostClientId`, which a desktop re-mints per process and which therefore names nothing
   * a relaunched client would answer to.
   */
  pairedDeviceId: string
  /** When the row was last written; the only input to never-returning-host expiry. */
  savedAt: number
}

/**
 * Compile-time proof that no live-authority field can be persisted.
 *
 * A reviewer's first question about restoring rows is whether a stored generation could ever be
 * replayed as authority. It cannot, because the durable type has nowhere to put one: adding any of
 * these names to `PersistedClientHostedBrowserPage` fails the build rather than the review.
 */
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

/**
 * How stale a row's timestamp may get before an unchanged projection is rewritten anyway.
 *
 * Without it the expiry would measure "when this page last changed" rather than "when a host last
 * held it", and a tab parked on one URL would age out while its host was there the whole time.
 */
export const CLIENT_HOSTED_BROWSER_PAGE_REFRESH_MS = 24 * 60 * 60 * 1000

const identity = z.string().min(1).max(256)

export const persistedClientHostedBrowserPageSchema: z.ZodType<PersistedClientHostedBrowserPage> =
  z.object({
    // Why a literal rather than a range: an unknown version is a row written by a build that knew
    // something this one does not, and partially trusting it is worse than dropping it. The
    // enclosing salvagingArray drops exactly the failing rows and keeps their siblings.
    v: z.literal(CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION),
    browserPageId: identity,
    workspaceId: identity,
    browserProfileId: identity,
    url: z.string().max(8192),
    title: z.string().max(4096),
    pairedDeviceId: identity,
    savedAt: z.number().int().nonnegative()
  })
