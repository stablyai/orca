// A bot's link, found by its package name: free of Node imports, so the renderer reads it too.

/** The cloud package a bot is shared as: fixed by its id, so *Update link* finds it again. */
export function botPackageName(botId: string): string {
  return `bot-${botId.replace(/-/g, '').toLowerCase()}`
}

/** A live bot link the owner made, as Orca Cloud lists it. */
export type BotOwnedShare = {
  id: string
  url: string
  packageId: string
  /** The package name, `bot-<id>`. */
  name: string
  createdAt: string
  canonical: boolean
  pinnedVersionId?: string
  /** For a link whose bot isn't on this computer: the bot's name as the link serves it. */
  displayName?: string
  /** For a bot on this computer: when the version the link serves was published, and its digest.
   *  Absent when the link couldn't be read, or from an older Orca. */
  pinnedPublishedAt?: string
  pinnedDigest?: string
}

export type BotShareStatus =
  | { shared: false }
  | {
      shared: true
      shareId: string
      url: string
      versionId: string
      createdAt: string
      /** When the link last changed: its version's publish time, else when it was made. */
      updatedAt: string
      /** The digest of what the link serves; null when unread, so the bot reads as changed. */
      digest: string | null
      /** Other live links of this bot, from older builds; nothing is stopped silently. */
      olderLinks: number
    }

/** Whether a bot is shared and where, from the owner's live links: its one canonical link. */
export function botShareStatusOf(shares: readonly BotOwnedShare[], botId: string): BotShareStatus {
  const own = shares.filter((share) => share.name === botPackageName(botId))
  const canonical = own.find((share) => share.canonical && share.pinnedVersionId)
  return canonical?.pinnedVersionId
    ? {
        shared: true,
        shareId: canonical.id,
        url: canonical.url,
        versionId: canonical.pinnedVersionId,
        createdAt: canonical.createdAt,
        updatedAt: canonical.pinnedPublishedAt ?? canonical.createdAt,
        digest: canonical.pinnedDigest ?? null,
        olderLinks: own.length - 1
      }
    : { shared: false }
}
