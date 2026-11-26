// Update link without the dialog: the bot as it is now, with the picks and note it was last
// published with. A secret stops it (the dialog shows where); an unchanged bot sends nothing.
import type { BotRef } from '@/lib/bot-hosts'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import { BOT_SHARE_ERRORS } from '../../../../../shared/bots/bot-share-errors'
import { prepareBotShare, settleBotShare, updateBotShare } from './bot-share-rpc'
import type { BotShareLink } from './use-bot-share-link'

export type BotShareInPlaceUpdate =
  | { kind: 'updated'; link: BotShareLink }
  | { kind: 'upToDate' }
  | { kind: 'secret' }
  | { kind: 'failed'; error: string; moved: boolean }

export async function updateBotShareInPlace(
  bot: BotRef,
  link: BotShareLink
): Promise<BotShareInPlaceUpdate> {
  const prepared = await settleBotShare(
    prepareBotShare(bot, {}, { last: true, skillsSession: createNonSecureContextUuid() })
  )
  if (!prepared.ok) {
    return { kind: 'failed', error: prepared.error, moved: false }
  }
  const { candidate, last } = prepared.value
  if (candidate.flags.some((flag) => flag.kind === 'secret')) {
    return { kind: 'secret' }
  }
  const note = last?.setupNote ?? ''
  // As the dialog's Up to date: same digest and same note; an unread digest counts as changed.
  if (
    link.digest !== null &&
    candidate.botDigest === link.digest &&
    note.trim() === (candidate.bot.setupNote ?? '')
  ) {
    return { kind: 'upToDate' }
  }
  const published = await settleBotShare(
    updateBotShare(bot, candidate.candidateId, note, {
      shareId: link.shareId,
      expectedVersionId: link.versionId
    })
  )
  if (!published.ok) {
    return {
      kind: 'failed',
      error: published.error,
      moved: published.code === BOT_SHARE_ERRORS.moved
    }
  }
  const { share, version } = published.value
  return {
    kind: 'updated',
    link: {
      shareId: share.id,
      url: share.url,
      versionId: share.pinnedVersionId,
      updatedAt: new Date().toISOString(),
      digest: version.packageDigest
    }
  }
}
