// The comment box's place on an item page while the agent's question is open: chat's question card, or,
// folded, chat's prompt strip above the comment box. A folded card stays mounted, hidden, so a
// half-given answer survives, as in chat.
import { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/use-runtime-environment-capability'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { botHostTarget } from '@/lib/bot-hosts'
import { BOTS_ITEM_ANSWERS_RUNTIME_CAPABILITY } from '../../../../../shared/bot-runtime-capabilities'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem, BotItemEvent } from '../../../../../shared/bots/bot-items'
import { botItemAskPrompt } from '../../../../../shared/bots/bot-item-ask'
import { NativeChatPromptStrip } from '../../native-chat/prompts/NativeChatPromptCollapse'
import { BotItemAskCard } from './BotItemAskCard'
import { BotItemAskDraftNotices } from './BotItemAskDraftNotice'
import type { BotItemCommentBoxHandle } from './BotItemCommentBox'

export type BotItemOpenAsk = {
  /** The question its card answers; null when the comment box takes the reply. */
  question: NonNullable<BotItem['question']> | null
  /** The card shows (not folded); the comment box hides behind it. */
  shown: boolean
  fold: () => void
  unfold: () => void
}

/** The agent's host environment: null for this computer, undefined when its host can't be reached. */
function hostEnvironmentOf(bot: Bot): string | null | undefined {
  try {
    return runtimeTargetEnvironmentId(botHostTarget(bot.hostId))
  } catch {
    return undefined
  }
}

/** Whether the agent's host records answers: this computer always does; a remote host says so, and
 *  the card appears once its answer comes. */
function useHostTakesAnswers(bot: Bot): boolean {
  const environmentId = hostEnvironmentOf(bot)
  // An unknown answer is no: an older host would refuse the answer's fields.
  const remote = useRuntimeEnvironmentCapability(
    environmentId,
    BOTS_ITEM_ANSWERS_RUNTIME_CAPABILITY
  )
  return environmentId === null || remote
}

/** The item's open question, when this page answers it in a card: a host that records answers marked
 *  it so. Otherwise (an older host, or a question from before it took answers) the comment box stays. */
export function useBotItemOpenAsk(bot: Bot, item: BotItem, deleted: boolean): BotItemOpenAsk {
  const hostTakesAnswers = useHostTakesAnswers(bot)
  const [folded, setFolded] = useState<string | null>(null)
  const question =
    !deleted && item.status === 'needs_you' && item.question?.answerable && hostTakesAnswers
      ? item.question
      : null
  return {
    question,
    shown: question !== null && folded !== question.eventId,
    fold: () => setFolded(question?.eventId ?? null),
    unfold: () => setFolded(null)
  }
}

export function BotItemAskSlot({
  bot,
  item,
  ask,
  events,
  onReconcile,
  commentRef
}: {
  bot: Bot
  item: BotItem
  ask: BotItemOpenAsk
  events: readonly BotItemEvent[]
  /** Reads the item again. */
  onReconcile: () => void
  /** Takes the card's handle while it shows, so the pane's typing reaches its answer field. */
  commentRef: React.RefObject<BotItemCommentBoxHandle | null>
}): React.JSX.Element {
  const t = useTranslate()
  const { question, shown } = ask
  const notices = (
    <BotItemAskDraftNotices
      bot={bot}
      item={item}
      events={events}
      openEventId={question?.eventId ?? null}
    />
  )
  if (!question) {
    return notices
  }
  const askedAt = events.find((event) => event.id === question.eventId)?.at ?? null
  return (
    <>
      {notices}
      <div hidden={!shown} inert={!shown} className="contents">
        <BotItemAskCard
          key={question.eventId}
          ref={shown ? commentRef : undefined}
          bot={bot}
          item={item}
          question={question}
          askedAt={askedAt}
          takeFocus={shown}
          onCollapse={ask.fold}
          onReconcile={onReconcile}
        />
      </div>
      {shown ? null : (
        <>
          <NativeChatPromptStrip
            card={{
              kind: 'question',
              prompt: botItemAskPrompt(question.text, question.ask ?? null)
            }}
            onExpand={ask.unfold}
          />
          {/* Files and images only go with a comment; the answer is the card's words and picks. */}
          <p className="shrink-0 px-4 pt-1.5 text-2xs text-muted-foreground">
            {t(
              'bots.items.ask.commentNotAnswer',
              'A comment, with any files, goes to the bot and moves this item to In progress, but isn’t recorded as your answer. Expand the question to answer it.'
            )}
          </p>
        </>
      )}
    </>
  )
}
