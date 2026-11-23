// The desktop's question steps (src/shared/bots/use-bot-item-question-steps), held in chat's draft
// store so a reload keeps them.
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { botRefKey } from '@/lib/bot-hosts'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem, BotItemEvent } from '../../../../../shared/bots/bot-items'
import type { BotItemPendingComment } from '../../../../../shared/bots/bot-item-pending-comments'
import {
  botItemHeldAnswersScope as heldScope,
  createBotItemQuestionStepsHooks,
  type BotItemQuestionStepsSend,
  type BotItemQuestionStepsState
} from '../../../../../shared/bots/use-bot-item-question-steps'
import { useNativeChatDraft } from '../../native-chat/drafts/use-native-chat-draft'

export type {
  BotItemQuestionSteps,
  BotItemQuickReplyActions,
  BotItemSentAnswers
} from '../../../../../shared/bots/use-bot-item-question-steps'

const NOT_COMPOSING = (): boolean => false

const hooks = createBotItemQuestionStepsHooks(
  { useCallback, useLayoutEffect, useMemo, useRef, useState },
  (scopeKey) => useNativeChatDraft(scopeKey, NOT_COMPOSING)
)

function itemScope(bot: Bot, itemUid: string): string {
  return `${botRefKey(bot)}:${itemUid}`
}

export function botItemHeldAnswersScope(bot: Bot, itemUid: string, askId: string): string {
  return heldScope(itemScope(bot, itemUid), askId)
}

export const { useBotItemHeldAnswers } = hooks

export function useBotItemQuestionSteps(
  bot: Bot,
  item: BotItem,
  events: readonly BotItemEvent[],
  send: BotItemQuestionStepsSend,
  pending: readonly BotItemPendingComment[]
): BotItemQuestionStepsState {
  return hooks.useBotItemQuestionSteps(itemScope(bot, item.uid), item, events, send, pending)
}
