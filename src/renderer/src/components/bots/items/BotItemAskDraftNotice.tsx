// An answer the owner was giving when its question went away (replaced, withdrawn, answered on another
// device) or that an older host can't record: said plainly, with the words kept to copy (or put in the
// comment box, for a question no longer open), never dropped and never sent on their own.
import { useEffect } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { botRefKey } from '@/lib/bot-hosts'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem, BotItemEvent } from '../../../../../shared/bots/bot-items'
import { botItemAnsweredQuestion } from '../../../../../shared/bots/bot-item-activity'
import { appendToNativeChatComposerDraft } from '../../native-chat/drafts/native-chat-composer-draft-store'
import {
  botItemAnswerDraftHasUnsentWords,
  botItemAnswerDraftSubmission,
  botItemAnswerDraftText,
  botItemAnswerDraftsToRecover,
  dropBotItemAnswerDraft,
  useBotItemAnswerDrafts,
  type BotItemAnswerDraft
} from './bot-item-answer-drafts'

type Fate =
  | 'ours'
  | 'oursEditedAfter'
  | 'hostCannotRecord'
  | 'answeredElsewhere'
  | 'uncertain'
  | 'changed'
  | 'withdrawn'

function fateOf(
  item: BotItem,
  events: readonly BotItemEvent[],
  eventId: string,
  draft: BotItemAnswerDraft
): Fate {
  const answer = events.find((event) => botItemAnsweredQuestion(event) === eventId)
  const answerId = typeof answer?.data.answerId === 'string' ? answer.data.answerId : undefined
  // The recorded attempt is this card's own: done only if the draft still holds what it submitted
  // and nothing unsent; otherwise the rest is offered back.
  const own =
    draft.answeredId ??
    (answerId && draft.attempts?.[answerId] !== undefined ? answerId : undefined)
  if (own !== undefined) {
    return draft.attempts?.[own] === botItemAnswerDraftSubmission(draft, eventId) &&
      !botItemAnswerDraftHasUnsentWords(draft)
      ? 'ours'
      : 'oursEditedAfter'
  }
  if (draft.hostCannotRecord) {
    return 'hostCannotRecord'
  }
  if (answer) {
    return 'answeredElsewhere'
  }
  if (draft.uncertain) {
    return 'uncertain'
  }
  return item.status === 'needs_you' && item.question ? 'changed' : 'withdrawn'
}

export function BotItemAskDraftNotices({
  bot,
  item,
  events,
  openEventId
}: {
  bot: Bot
  item: BotItem
  events: readonly BotItemEvent[]
  /** The question whose card takes answers now; its draft is the card's own. */
  openEventId: string | null
}): React.JSX.Element | null {
  const drafts = useBotItemAnswerDrafts()
  const t = useTranslate()
  const recover = botItemAnswerDraftsToRecover(drafts, botRefKey(bot), item.uid, openEventId).map(
    (entry) => ({ ...entry, fate: fateOf(item, events, entry.eventId, entry.draft) })
  )
  const ours = recover
    .filter((entry) => entry.fate === 'ours')
    .map((entry) => entry.key)
    .join('\n')
  // Its receipt in Activity says it went: nothing is left to offer back.
  useEffect(() => {
    if (ours) {
      ours.split('\n').forEach(dropBotItemAnswerDraft)
    }
  }, [ours])
  const shown = recover.filter((entry) => entry.fate !== 'ours')
  if (shown.length === 0) {
    return null
  }
  const title: Record<Exclude<Fate, 'ours'>, string> = {
    oursEditedAfter: t(
      'bots.items.ask.oursEditedAfter',
      'Your answer was recorded. Words of yours it didn’t include are kept here.'
    ),
    hostCannotRecord: t(
      'bots.items.ask.hostCannotRecord',
      'This Orca host can’t record answers yet, so nothing was sent. Update Orca on the bot’s computer; your answer is kept here.'
    ),
    answeredElsewhere: t(
      'bots.items.ask.answeredElsewhere',
      'Answered elsewhere before yours went. Your answer is kept here.'
    ),
    changed: t(
      'bots.items.ask.changed',
      'This question changed before your answer went. Your answer is kept here.'
    ),
    withdrawn: t(
      'bots.items.ask.withdrawn',
      'This question closed before your answer went. Your answer is kept here.'
    ),
    uncertain: t(
      'bots.items.ask.uncertain',
      'This question closed while your answer was being sent, and no reply came, so it may not have gone. Check Activity; your answer is kept here.'
    )
  }
  return (
    <div className="flex shrink-0 flex-col gap-2 px-3.5 pt-2">
      {shown.map(({ key, draft, fate }) => {
        const text = botItemAnswerDraftText(draft)
        if (fate === 'ours') {
          return null
        }
        return (
          <div
            key={key}
            role="status"
            data-bot-item-answer-draft={fate}
            className="rounded-[14px] border border-question-card-border bg-chat-composer-surface px-3.5 py-2.5 text-xs"
          >
            <p className="font-medium text-foreground">{title[fate]}</p>
            <p className="mt-1.5 max-h-40 select-text overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground scrollbar-sleek">
              {text}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(text)
                    .then(() => toast.success(t('bots.items.ask.copied', 'Copied')))
                }
              >
                {t('bots.items.ask.copy', 'Copy')}
              </Button>
              {/* A comment on a waiting item there would answer whichever question is open. */}
              {fate === 'hostCannotRecord' ? null : (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    appendToNativeChatComposerDraft(
                      `bot-item-comment:${botRefKey(bot)}:${item.uid}`,
                      {
                        text
                      }
                    )
                    dropBotItemAnswerDraft(key)
                  }}
                >
                  {t('bots.items.ask.toComment', 'Draft comment')}
                </Button>
              )}
              <Button size="xs" variant="ghost" onClick={() => dropBotItemAnswerDraft(key)}>
                {t('bots.items.ask.dismiss', 'Dismiss')}
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
