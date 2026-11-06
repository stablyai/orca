/**
 * What a WSL move did with the desktop's in-app browser logins (owner decision 3): copied once into
 * the WSL host's route partition, or left the host on a fresh partition and says why.
 */
import { z } from 'zod'

export const WSL_MOVE_BROWSER_COOKIES_STORE_ID = 'browser-cookies'

export const WSL_MOVE_BROWSER_COOKIE_FRESH_PARTITION_REASONS = [
  // The host has no deployment link, so its partition names the pairing and the next orcad
  // relaunch would move it, stranding the copy.
  'no-stable-partition',
  'destination-not-wsl-host',
  'destination-environment-missing',
  // Another identity already owns the partition name this host derives.
  'destination-partition-conflict'
] as const

export type WslMoveBrowserCookieFreshPartitionReason =
  (typeof WSL_MOVE_BROWSER_COOKIE_FRESH_PARTITION_REASONS)[number]

const count = z.number().int().nonnegative().max(1_000_000)

const WslMoveBrowserCookieCopyCountsSchema = z.object({
  copied: count,
  /** Subsets of `copied`, by the kinds the design asked about. */
  copiedHttpOnly: count,
  copiedPartitioned: count,
  copiedSessionOnly: count,
  /** The host jar already held the cookie; its value wins. */
  skippedPresent: count,
  /** Sites that bind a login to the jar that minted it; a copy would sign out both jars. */
  skippedSourceBound: count,
  /** Partitioned under an opaque top-level site, which no write can address. */
  skippedOpaquePartition: count,
  /** Unreadable or refused by the cookie store (e.g. an invalid value or prefix). */
  rejected: count
})

export type WslMoveBrowserCookieCopyCounts = z.infer<typeof WslMoveBrowserCookieCopyCountsSchema>

export function emptyWslMoveBrowserCookieCopyCounts(): WslMoveBrowserCookieCopyCounts {
  return {
    copied: 0,
    copiedHttpOnly: 0,
    copiedPartitioned: 0,
    copiedSessionOnly: 0,
    skippedPresent: 0,
    skippedSourceBound: 0,
    skippedOpaquePartition: 0,
    rejected: 0
  }
}

export const WSL_MOVE_BROWSER_COOKIE_COPY_MAX_PROFILES = 256

export const WslMoveBrowserCookieCopySchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('copied'),
    profiles: z
      .array(
        z.object({
          browserProfileId: z.string().min(1).max(256),
          destinationPartition: z.string().min(1).max(256),
          /** An earlier move to this host already copied into this partition. */
          alreadyCopied: z.boolean(),
          counts: WslMoveBrowserCookieCopyCountsSchema
        })
      )
      .max(WSL_MOVE_BROWSER_COOKIE_COPY_MAX_PROFILES)
  }),
  z.object({
    outcome: z.literal('fresh-partition'),
    reason: z.enum(WSL_MOVE_BROWSER_COOKIE_FRESH_PARTITION_REASONS)
  })
])

export type WslMoveBrowserCookieCopy = z.infer<typeof WslMoveBrowserCookieCopySchema>
