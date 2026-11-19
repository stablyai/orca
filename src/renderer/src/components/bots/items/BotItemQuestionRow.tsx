// An agent's Needs you question in an item's Activity. Closed, it is a quiet question card: what was asked,
// then the recorded answer ("You answered: …") or that none came. Open, its answerable card sits in the
// comment box's place, so here it is only chat's "Awaiting user input" line when later entries follow
// it; a question this page can't answer in a card (an older host) shows here in the open look instead,
// and the comment box below takes the reply.
import { Check } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { cn } from '@/lib/class-names'
import type { BotItem, BotItemEvent } from '../../../../../shared/bots/bot-items'
import type { BotItemQuestionState } from '../../../../../shared/bots/bot-item-activity'
import { botItemActorName } from '../../../../../shared/bots/bot-item-actor-name'
import {
  botItemAnswerLines,
  botItemAnswerOf,
  botItemAskOf,
  botItemQuestionLine
} from '../../../../../shared/bots/bot-item-ask'
import type { NativeChatAskRowSubject } from '../../../../../shared/native-chat/input/questions/native-chat-ask-row'
import { NativeChatAwaitingInputRow } from '../../native-chat/prompts/NativeChatAwaitingInputRow'
import {
  BOT_ITEM_CLOSED_ASK_SURFACE,
  BOT_ITEM_OPEN_ASK_SURFACE,
  BotItemQuestionHeading,
  BotItemWaitingFlag
} from './BotItemAskLook'
import { BotItemClampedText } from './BotItemClampedText'
import { BOT_ITEM_COMMENT_ATTRIBUTE } from './BotItemCommentCard'

const TIME = { hour: 'numeric', minute: '2-digit' } as const

function textOf(event: BotItemEvent): string {
  return typeof event.data.text === 'string' ? event.data.text : ''
}

/** The agent's own words around its decisions, shown as its comment; null for a prose question. */
export function botItemQuestionContext(event: BotItemEvent): string | null {
  return botItemAskOf(event.data)?.context ?? null
}

/** The open question's place in Activity while its card is below. */
export function BotItemAwaitingRow({ event }: { event: BotItemEvent }): React.JSX.Element {
  const ask = botItemAskOf(event.data)
  const subject: NativeChatAskRowSubject = !ask
    ? { kind: 'question', text: textOf(event) }
    : ask.questions.length === 1
      ? { kind: 'question', text: ask.questions[0]!.prompt }
      : { kind: 'questions', questions: ask.questions.map((question) => question.prompt) }
  return (
    <div data-bot-item-question="awaiting">
      <NativeChatAwaitingInputRow
        subject={subject}
        pending
        disclosureKey={`item:${event.id}`}
        headline={subject.kind === 'question' ? botItemQuestionLine(subject.text) : undefined}
      />
    </div>
  )
}

/** A question as a card in Activity: closed and quiet, or open where no card below takes its answer. */
export function BotItemQuestionCard({
  item,
  event,
  state,
  answer,
  onJump
}: {
  item: BotItem
  event: BotItemEvent
  state: BotItemQuestionState
  /** The reply or recorded answer that closed it, when it names the question. */
  answer?: BotItemEvent
  /** Scrolls to and focuses another comment (a reply that answered), by its event id. */
  onJump?: (eventId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const open = state === 'open'
  const ask = botItemAskOf(event.data)
  const recorded = answer ? botItemAnswerOf(answer.data) : null
  const lines = recorded ? botItemAnswerLines(ask, recorded.answers) : []
  const decisions = ask ? ask.questions.map((question) => question.prompt) : [textOf(event)]
  const time = uiDateTimeFormat(TIME).format(answer?.at ?? event.at)
  return (
    // Opaque under the card, so the Activity rail never shows through its dimmed fill.
    <div className="relative my-2 rounded-[14px] bg-sidebar">
      <div
        data-bot-item-question={state}
        {...{ [BOT_ITEM_COMMENT_ATTRIBUTE]: event.id }}
        tabIndex={-1}
        className={cn(
          'outline-none focus:ring-2 focus:ring-ring/50',
          open
            ? cn('rounded-[14px] border bg-chat-composer-surface', BOT_ITEM_OPEN_ASK_SURFACE)
            : BOT_ITEM_CLOSED_ASK_SURFACE,
          'space-y-2 px-3.5 py-2.5'
        )}
      >
        <div className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
          {open ? <BotItemWaitingFlag /> : null}
          <span className={cn('min-w-0 truncate', open && 'ml-auto')}>
            {botItemActorName(event, item, t)}
          </span>
          <span className={cn('shrink-0 tabular-nums', !open && 'ml-auto')}>
            {uiDateTimeFormat(TIME).format(event.at)}
          </span>
        </div>
        {decisions.map((decision, index) => (
          // A decision's question is unique within its ask.
          <div key={decision} className="space-y-1">
            <BotItemQuestionHeading text={decision} muted={!open} />
            {lines[index] ? <AnsweredLine answer={lines[index].answer} /> : null}
          </div>
        ))}
        {open ? null : lines.length > 0 ? (
          <p className="text-2xs tabular-nums text-muted-foreground">{time}</p>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {state === 'answered' && answer && onJump ? (
              // A reply answered it: it leads there, as the reply's quote leads back here.
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-sm outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
                aria-label={t(
                  'bots.items.activity.goToAnswer',
                  'Answered at {{time}}. Go to the answer',
                  { time }
                )}
                onClick={() => onJump(answer.id)}
              >
                <Check className="size-3" />
                {t('bots.items.ask.answeredInComment', 'Answered in a comment')}
              </button>
            ) : state === 'answered' ? (
              <>
                <Check className="size-3" />
                {t('bots.items.ask.answeredInComment', 'Answered in a comment')}
              </>
            ) : (
              t('bots.items.ask.notAnswered', 'Not answered')
            )}
          </p>
        )}
      </div>
    </div>
  )
}

/** One decision's recorded answer: the emerald check, then "You answered:" and the answer in bold. */
function AnsweredLine({ answer }: { answer: string }): React.JSX.Element {
  const t = useTranslate()
  return (
    <p className="flex min-w-0 items-start gap-1.5 text-xs text-foreground">
      <span className="mt-px flex size-3.5 shrink-0 items-center justify-center rounded-full bg-status-success/15 text-status-success">
        <Check className="size-2.5" strokeWidth={3} />
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-words">
        {answer ? (
          <>
            {t('bots.items.ask.youAnswered', 'You answered:')}{' '}
            <b className="font-semibold">{answer}</b>
          </>
        ) : (
          t('bots.items.ask.skipped', 'Skipped')
        )}
      </span>
    </p>
  )
}

/** A recorded answer whose question is outside the loaded page: the prose question it kept, then the
 *  whole answer (an ask's answer spells out each decision), with Show more past six lines. */
export function BotItemOrphanAnswer({ event }: { event: BotItemEvent }): React.JSX.Element {
  const t = useTranslate()
  const asked = typeof event.data.asked === 'string' ? event.data.asked : ''
  return (
    <div className="relative my-2 rounded-[14px] bg-sidebar">
      <div
        data-bot-item-question="answer"
        className={cn(BOT_ITEM_CLOSED_ASK_SURFACE, 'space-y-1.5 px-3.5 py-2.5 text-xs')}
      >
        <div className="flex items-center gap-2 text-2xs text-muted-foreground">
          <span>{t('bots.items.ask.answeredEarlier', 'You answered an earlier question')}</span>
          <span className="ml-auto tabular-nums">{uiDateTimeFormat(TIME).format(event.at)}</span>
        </div>
        {asked ? <BotItemQuestionHeading text={asked} muted /> : null}
        <BotItemClampedText
          text={textOf(event)}
          clampClassName="line-clamp-6"
          render={(shown) => (
            <p className="whitespace-pre-wrap break-words text-foreground">{shown}</p>
          )}
        />
      </div>
    </div>
  )
}
