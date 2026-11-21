// The desktop's pending comments on an item: sent through the bot's host, a failure as a toast.
import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { botRefKey, botTarget, type BotRef } from '@/lib/bot-hosts'
import { readCachedRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import {
  BOTS_ITEM_COMMENT_PLAIN_RUNTIME_CAPABILITY,
  BOTS_ITEM_COMMENT_QUESTION_ID_RUNTIME_CAPABILITY,
  BOTS_ITEM_COMMENT_REQUEST_ID_RUNTIME_CAPABILITY
} from '../../../../../shared/bot-runtime-capabilities'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import {
  botItemPendingCommentText,
  createBotItemPendingCommentsHook,
  type BotItemPendingComments
} from '../../../../../shared/bots/bot-item-pending-comments'
import type { RuntimeCapability } from '../../../../../shared/remote-runtime/protocol/protocol-version'
import { useTranslate } from '@/i18n/use-translate'
import { botErrorMessage } from '../bot-presentation'
import { commentOnBotItem } from './use-bot-items'

const usePendingComments = createBotItemPendingCommentsHook({ useEffect, useSyncExternalStore })

export function useBotItemPendingComments(
  bot: BotRef,
  uid: string,
  events: readonly BotItemEvent[]
): BotItemPendingComments {
  const t = useTranslate()
  return usePendingComments(`${botRefKey(bot)}\0${uid}`, events, {
    post: (entry) =>
      commentOnBotItem(
        bot,
        uid,
        botItemPendingCommentText(entry),
        entry.paths,
        entry.requestId ?? undefined,
        entry.questionId ?? undefined,
        entry.plain
      ),
    failed: (error, replaced) =>
      toast.error(
        replaced
          ? t('bots.items.ask.replaced', 'The agent asked a new question. Read it, then reply.')
          : botErrorMessage(error)
      ),
    requestIds: takesCapability(bot, BOTS_ITEM_COMMENT_REQUEST_ID_RUNTIME_CAPABILITY),
    questionIds: takesCapability(bot, BOTS_ITEM_COMMENT_QUESTION_ID_RUNTIME_CAPABILITY),
    plain: takesCapability(bot, BOTS_ITEM_COMMENT_PLAIN_RUNTIME_CAPABILITY)
  })
}

/** An unknown answer is no: an older host refuses the field. This app's own host always takes it. */
function takesCapability(bot: BotRef, capability: RuntimeCapability): boolean {
  const environmentId = runtimeTargetEnvironmentId(botTarget(bot))
  return (
    environmentId === null ||
    readCachedRuntimeEnvironmentCapability(environmentId, capability) === true
  )
}
