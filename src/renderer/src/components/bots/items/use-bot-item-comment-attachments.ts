// Stage the files on the item's host. The host claims them for the chat receiving the comment.
import { useMemo } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { readCachedRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import type { NativeChatStructuredAttachmentSession } from '../../native-chat/attachments/uploads/native-chat-attachment-owner'
import {
  BOTS_ITEM_ATTACHMENT_STAGING_RUNTIME_CAPABILITY,
  BOTS_ITEM_COMMENT_ATTACHMENTS_RUNTIME_CAPABILITY
} from '../../../../../shared/bot-runtime-capabilities'
import { botItemAttachmentTarget } from '../../../../../shared/agent-session/agent-session-attachments'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import { useBotHostLabel } from '../use-bot-host-label'

export type BotItemCommentAttachTarget = {
  /** The bot's folder workspace, which drops and pastes resolve their owner against. */
  worktreeId: string
  /** Null: the bot runs on this computer. */
  runtimeEnvironmentId: string | null
}

export type BotItemCommentAttachments = {
  /** The chat uploads go to; null when nothing can be attached. */
  session: NativeChatStructuredAttachmentSession | null
  /** Why a paste or drop can't attach, said in place of attaching. */
  blocked: string | null
}

export function useBotItemCommentAttachments(
  bot: Pick<Bot, 'hostId'>,
  item: Pick<BotItem, 'chat' | 'uid'>,
  target: BotItemCommentAttachTarget | null
): BotItemCommentAttachments {
  const t = useTranslate()
  const hostLabel = useBotHostLabel(bot.hostId)
  const environmentId = target?.runtimeEnvironmentId ?? null
  // An unknown answer is no: an older host refuses the images field.
  const hostTakes =
    environmentId === null ||
    readCachedRuntimeEnvironmentCapability(
      environmentId,
      BOTS_ITEM_COMMENT_ATTACHMENTS_RUNTIME_CAPABILITY
    ) === true
  const { id, gone, title } = item.chat
  const itemTarget =
    environmentId === null ||
    readCachedRuntimeEnvironmentCapability(
      environmentId,
      BOTS_ITEM_ATTACHMENT_STAGING_RUNTIME_CAPABILITY
    ) === true
      ? botItemAttachmentTarget(item.uid)
      : null
  return useMemo((): BotItemCommentAttachments => {
    if (!itemTarget && gone) {
      return {
        session: null,
        blocked: t(
          'bots.items.comment.chatDeleted',
          "{{chat}} was deleted, so files can't be attached here.",
          { chat: title ?? t('bots.items.chatFallback', 'Chat') }
        )
      }
    }
    if (!hostTakes) {
      return {
        session: null,
        blocked: t(
          'bots.items.comment.hostTooOld',
          '{{host}} needs an update to attach files to comments.',
          { host: hostLabel ?? t('bots.items.comment.thisServer', 'This server') }
        )
      }
    }
    if (!target) {
      return { session: null, blocked: null }
    }
    return {
      session: { sessionId: itemTarget ?? id, runtimeEnvironmentId: environmentId },
      blocked: null
    }
  }, [environmentId, gone, hostLabel, hostTakes, id, itemTarget, t, target, title])
}
