// How a picture made for a bot that exists reaches it: one upload, claimed before it starts, behind the
// host's revision check, and only while no newer choice was made. See avatar-generation-requests.ts.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { botRefKey, type BotRef } from '@/lib/bot-hosts'
import { botHostHas } from '@/lib/bot-host-status'
import { readBotGenerationRevision, uploadBotAvatar } from '@/lib/bot-catalog'
import type { BotPictureRevision } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import { BOTS_AVATAR_REVISION_RUNTIME_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import type {
  AvatarGenerationFailure,
  AvatarImageAgent
} from '../../../../shared/avatar-generation/avatar-generation-contract'
import { botErrorMessage } from './bot-presentation'
import { keepSavedPictureDescription } from './generated-avatar-descriptions'
import { beginAutomaticBotPictureUpload, botPictureOpsOpen } from './bot-picture-ops'

/** The last picture made: the square 512 px PNG an upload would save, and what it was asked for. */
export type GeneratedAvatar = { png: string; description: string }

/** The picker (or its host) that asked, while it is mounted. */
export type AvatarRequestHost = {
  /** The picture made. `apply` is true when the host should place it itself: for a bot not yet made,
   *  when no newer choice was made since. A bot that exists gets it here instead. */
  landed: (made: GeneratedAvatar, apply: boolean) => void
  failed: (failure: AvatarGenerationFailure, agent: AvatarImageAgent) => void
  /** Back to idle with nothing made (canceled). */
  ended: (saved?: Bot) => void
}

/** Who a picture is for, as a run starts: a bot not yet made (`key` names its picture choices in the
 *  ledger), or a bot that exists. */
export type AvatarRequestOwner = { kind: 'draft'; key: string } | { kind: 'bot'; bot: Bot }

export type Owner =
  | { kind: 'draft'; key: string }
  | { kind: 'creating'; key: string; name: string }
  | { kind: 'bot'; ref: BotRef; name: string }

/** The bot revision an upload requires: the one at Generate, or, while picture saves begun earlier are
 *  still in flight, the one they are acknowledged at. */
export type Anchor = {
  revision: BotPictureRevision | Promise<BotPictureRevision | null>
  waiting: boolean
  acked: Set<number>
}

export type Request = {
  id: string
  description: string
  agent: AvatarImageAgent
  status: 'running' | 'landed' | 'failed' | 'applying'
  made: GeneratedAvatar | null
  failure: AvatarGenerationFailure | null
  owner: Owner
  /** Cleared by any picture or color choice for the same owner after Generate. */
  eligible: boolean
  host: AvatarRequestHost | null
  anchor: Anchor | null
}

export function failedForToast(name: string): void {
  toast.error(
    translate('bots.avatar.generate.failedFor', "Couldn't generate a picture for {{name}}.", {
      name
    })
  )
}

export function canCheckRevision(ref: BotRef): boolean {
  return botHostHas(ref.hostId, BOTS_AVATAR_REVISION_RUNTIME_CAPABILITY)
}

export function anchorAt(bot: Bot): Anchor {
  // A legacy bot has no revision yet: 0, sent explicitly, so its first automatic upload is still checked.
  return {
    revision: canCheckRevision(bot)
      ? readBotGenerationRevision(bot, bot.avatarRevision ?? 0, bot.avatarRevisionEpoch).catch(
          () => null
        )
      : { revision: bot.avatarRevision ?? 0, epoch: bot.avatarRevisionEpoch },
    waiting: botPictureOpsOpen(botRefKey(bot)),
    acked: new Set<number>()
  }
}

/** Uploads a landed picture to its bot, once, if it is still the latest choice and the host can check;
 *  `finish` forgets the request. */
export function tryApply(request: Request, finish: (request: Request, saved?: Bot) => void): void {
  if (request.status !== 'landed' || request.owner.kind !== 'bot' || !request.made) {
    return
  }
  const { ref, name } = request.owner
  if (!request.eligible) {
    // A newer choice won; an open picker keeps the picture in its slot.
    finish(request)
    return
  }
  if (!canCheckRevision(ref)) {
    // No upload without the revision check; an open picker keeps it for an explicit pick.
    finish(request)
    if (!request.host) {
      failedForToast(name)
    }
    return
  }
  const anchor = request.anchor
  if (!anchor || anchor.waiting) {
    return
  }
  // Claimed before the upload starts, so nothing else can issue it.
  request.status = 'applying'
  const { png, description } = request.made
  const automatic = beginAutomaticBotPictureUpload(botRefKey(ref))
  const upload = async (): Promise<Bot> => {
    const token = await anchor.revision
    if (token === null) {
      throw new Error('bot_avatar_home_unreadable')
    }
    let revision = token.revision
    while (anchor.acked.delete(revision + 1)) {
      revision += 1
    }
    if (!request.eligible) {
      throw new Error('bot_avatar_changed')
    }
    return uploadBotAvatar(ref, png, { ...token, revision })
  }
  let acknowledged: Bot | undefined
  void upload()
    .then(
      (saved) => {
        acknowledged = saved
        keepSavedPictureDescription(saved, png, description, { prefer: 'known' })
      },
      (error: unknown) => {
        if (error instanceof Error && error.message === 'bot_avatar_changed') {
          // A newer choice landed first: it wins, silently.
          return
        }
        if (request.host) {
          toast.error(botErrorMessage(error))
        } else {
          failedForToast(name)
        }
      }
    )
    .finally(() => {
      finish(request, acknowledged)
      automatic.end()
    })
}
