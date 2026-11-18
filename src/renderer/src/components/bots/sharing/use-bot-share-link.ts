// The bot's one live link as the Share dialog reads it: from the caller, or read from Orca Cloud.
import { useCallback, useEffect, useState } from 'react'
import {
  botShareStatusOf,
  type BotOwnedShare,
  type BotShareStatus
} from '../../../../../shared/bots/bot-share-status'
import { BOT_SHARE_ERRORS } from '../../../../../shared/bots/bot-share-errors'
import { botShareErrorCode } from './bot-share-error-copy'
import { listBotShares } from './bot-share-rpc'

export type BotShareLink = {
  shareId: string
  url: string
  versionId: string
  /** When the link last changed; null when unknown. */
  updatedAt: string | null
  /** The digest of what it serves; null when unread, so the bot reads as changed. */
  digest: string | null
}

export type BotShareStart = 'open' | 'update' | 'stop'

export function botShareLinkOf(status: BotShareStatus): BotShareLink | null {
  return status.shared
    ? {
        shareId: status.shareId,
        url: status.url,
        versionId: status.versionId,
        updatedAt: status.updatedAt,
        digest: status.digest
      }
    : null
}

/** A row of Settings › Shared links as the link it is. */
export function botShareLinkOfShare(share: BotOwnedShare): BotShareLink {
  return {
    shareId: share.id,
    url: share.url,
    versionId: share.pinnedVersionId ?? '',
    updatedAt: share.pinnedPublishedAt ?? share.createdAt,
    digest: share.pinnedDigest ?? null
  }
}

export type LinkRead =
  | { kind: 'loading' }
  | { kind: 'read'; link: BotShareLink | null }
  | { kind: 'offline' }
  | { kind: 'signIn' }

/** The bot's live link, read from Orca Cloud when the caller doesn't know it. */
export function useBotShareLink(
  botId: string,
  known: BotShareLink | null | undefined,
  skip: boolean
): { read: LinkRead; setLink: (link: BotShareLink | null) => void; reread: () => void } {
  const [read, setRead] = useState<LinkRead>(
    known === undefined ? { kind: 'loading' } : { kind: 'read', link: known }
  )
  const [version, setVersion] = useState(known === undefined ? 1 : 0)
  useEffect(() => {
    if (version === 0 || skip) {
      return
    }
    let live = true
    setRead({ kind: 'loading' })
    listBotShares(botId).then(
      (shares) =>
        live && setRead({ kind: 'read', link: botShareLinkOf(botShareStatusOf(shares, botId)) }),
      (cause: unknown) => {
        if (!live) {
          return
        }
        const code = botShareErrorCode(cause)
        setRead(
          code === BOT_SHARE_ERRORS.signIn || code === BOT_SHARE_ERRORS.reconnect
            ? { kind: 'signIn' }
            : { kind: 'offline' }
        )
      }
    )
    return () => {
      live = false
    }
  }, [botId, version, skip])
  return {
    read,
    setLink: useCallback((link) => setRead({ kind: 'read', link }), []),
    reread: useCallback(() => setVersion((current) => current + 1), [])
  }
}
