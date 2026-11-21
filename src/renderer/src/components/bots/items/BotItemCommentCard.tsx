// A comment in an item's Activity: one quiet surface for every author, with avatar, name and time, then
// the text as Markdown, its images and its file links. An agent's Needs you question is a comment too:
// its body and attachments, then its question footer (BotItemQuestionLines). A reply to a question quotes it, and leads back to it;
// an answer to several lines of an ask quotes each line above its words, with that line's images under
// them. Answers held on this device show the same way, "Not sent yet" where the time goes.
// While the item waits on it, the asking comment stands out: a Needs you tag by its time and its
// question ruled off from the body. Answered, it reads as any other comment.
import { useState } from 'react'
import { CornerDownRight } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { cn } from '@/lib/class-names'
import type { Bot } from '../../../../../shared/bot-types'
import {
  botItemCommentImages,
  type BotItem,
  type BotItemCommentImage,
  type BotItemEvent
} from '../../../../../shared/bots/bot-items'
import { botItemCommentFiles } from '../../../../../shared/bots/bot-item-comment-files'
import { BotItemCommentImages } from './BotItemCommentImages'
import { BotItemCommentFiles } from './BotItemCommentFiles'
import { stripSentImagePromptMarkers } from '../../../../../shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import { botInitial } from '../../../../../shared/bots/bot-avatar-fallback'
import { BotAvatar, BotAvatarTile } from '../BotAvatar'
import { BotOwnerAvatar } from '../bot-connector-people'
import { BotItemClampedText } from './BotItemClampedText'
import type {
  BotItemActivityEntry,
  BotItemAnswered
} from '../../../../../shared/bots/bot-item-activity'
import { botItemLineImages } from '../../../../../shared/bots/bot-item-answer-lines'
import { BotItemMarkdown } from './BotItemMarkdown'
import type { BotItemJumpTarget } from './bot-item-jump'
import { botItemActorName } from '../../../../../shared/bots/bot-item-actor-name'
import { botItemQuestionShape } from '../../../../../shared/bots/bot-item-ask'
import { BotItemQuestionLines } from './BotItemQuestionLines'
import type { BotItemQuickReplyActions } from './use-bot-item-question-steps'
import { botItemHeldAnswerScope } from './bot-item-held-answers'

const TIME = { hour: 'numeric', minute: '2-digit' } as const

/** The asking comment's question, ruled off across the card's full width, its words still on the body's
 *  edge: bleeds past the body's `pl-7` and the card's `px-2`, then pads back. */
const QUESTION_RULE = '-ml-9 -mr-2 mt-2.5 border-t border-border pl-9 pr-2 pt-2.5'

function NeedsYouTag(): React.JSX.Element {
  const t = useTranslate()
  return (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-agent-question/12 px-2 py-px text-2xs font-semibold leading-4 text-agent-question-text">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-agent-question" />
      {t('bots.items.status.needsYou', 'Needs you')}
    </span>
  )
}

function Avatar({
  bot,
  event,
  name
}: {
  bot: Bot
  event: BotItemEvent
  name: string
}): React.JSX.Element {
  const { actor } = event
  if (actor.kind === 'owner') {
    return (
      <span className="size-5 shrink-0">
        <BotOwnerAvatar />
      </span>
    )
  }
  if (actor.kind === 'bot' && actor.botId === bot.id) {
    return <BotAvatar bot={bot} className="size-5 rounded text-2xs" />
  }
  return (
    <BotAvatarTile src={null} fallback={botInitial(name)} className="size-5 rounded text-2xs" />
  )
}

type CommentEntry = Pick<
  Extract<BotItemActivityEntry, { kind: 'comment' }>,
  'event' | 'replyTo' | 'answers' | 'answered'
> & { waiting?: boolean }

/** Marks a card so a jump can find and focus it. */
export const BOT_ITEM_COMMENT_ATTRIBUTE = 'data-bot-item-comment-id'

export function BotItemCommentCard({
  bot,
  item,
  entry,
  onJump,
  failed,
  held,
  sending = false,
  quickReplies
}: {
  bot: Bot
  item: BotItem
  entry: CommentEntry
  /** Scrolls to and focuses a question line or another comment. */
  onJump?: (target: BotItemJumpTarget) => void
  /** A comment sent from the box that the host refused. */
  failed?: { retry: () => void; discard: () => void }
  /** Answers held on this device: not sent yet, with Send now in the time's place. */
  held?: { sendNow: () => void; edit: (line: number) => void }
  /** Just sent from here: its time fades in where "Not sent yet" was. */
  sending?: boolean
  /** On the question the item waits on, until the owner replies. */
  quickReplies?: BotItemQuickReplyActions
}): React.JSX.Element {
  const t = useTranslate()
  const { event, replyTo, answered } = entry
  const waiting = entry.waiting === true
  const images = botItemCommentImages(event.data)
  const shape = botItemQuestionShape(event.data)
  // An answer's images show under the lines that name them; the rest after the words.
  const lineImages = answered?.lines.map(({ words }) => botItemLineImages(words, images.length))
  const claimed = new Set(lineImages?.flat())
  const restImages = claimed.size > 0 ? images.filter((_, at) => !claimed.has(at)) : images
  // Its images show after the words, so the [Image #N] its send wrote go, as in chat's sent messages.
  // Its files show as links after them, so their `@path`s go from the words.
  const { words } = botItemCommentFiles(
    stripSentImagePromptMarkers(answered ? answered.rest : shape.body, images.length)
  )
  const { files } = botItemCommentFiles(typeof event.data.text === 'string' ? event.data.text : '')
  const name = botItemActorName(event, item, t)
  const format = uiDateTimeFormat(TIME)
  const jump =
    'rounded-sm outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50'
  return (
    // Opaque under the surface's tint so the Activity rail never shows through. It bleeds past the
    // column so the avatar and time sit on the event rows' glyph and time edges.
    <div
      className={cn('relative -mx-2 my-1 rounded-[10px] bg-sidebar', held && 'bot-item-grow-in')}
    >
      <div
        {...{ [BOT_ITEM_COMMENT_ATTRIBUTE]: event.id }}
        tabIndex={-1}
        role="article"
        aria-label={t('bots.items.activity.commentLabel', '{{name}}, {{time}}', {
          name,
          time: held ? t('bots.items.activity.notSentYet', 'Not sent yet') : format.format(event.at)
        })}
        className={cn(
          'rounded-[10px] bg-foreground/[0.035] px-2 pt-1.5 outline-none focus:ring-2 focus:ring-ring/50 dark:bg-foreground/[0.045]',
          // A question's chips end the card: more room under them.
          shape.decisions.length > 0 ? 'pb-4' : 'pb-2'
        )}
      >
        <div className="mb-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <Avatar bot={bot} event={event} name={name} />
          <b className="min-w-0 truncate text-[13px] font-medium text-foreground">{name}</b>
          {waiting ? <NeedsYouTag /> : null}
          {held ? (
            <span className="ml-auto flex shrink-0 items-center gap-1 text-2xs whitespace-nowrap">
              {t('bots.items.activity.notSentYet', 'Not sent yet')} ·
              <button
                type="button"
                className="rounded-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
                onClick={held.sendNow}
              >
                {t('bots.items.activity.sendNow', 'Send now')}
              </button>
            </span>
          ) : (
            <span
              className={cn(
                'shrink-0 text-2xs tabular-nums',
                !waiting && 'ml-auto',
                sending &&
                  'duration-[180ms] animate-in fade-in-0 slide-in-from-bottom-[3px] motion-reduce:animate-none'
              )}
            >
              {format.format(event.at)}
            </span>
          )}
        </div>
        {replyTo && !answered ? (
          <button
            type="button"
            className={cn(
              'mb-0.5 flex max-w-full min-w-0 items-center gap-1 pl-7 text-xs text-muted-foreground',
              jump
            )}
            aria-label={t(
              'bots.items.activity.replyingTo',
              'Replying to: {{question}}. Go to the question',
              {
                question: replyTo.text.slice(0, 80)
              }
            )}
            disabled={!onJump}
            onClick={() => onJump?.({ eventId: replyTo.eventId, line: replyTo.line })}
          >
            <CornerDownRight className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{replyTo.text}</span>
          </button>
        ) : null}
        <div className="pl-7">
          {answered && lineImages ? (
            <BotItemAnswerLines
              answered={answered}
              images={images}
              lineImages={lineImages}
              held={held}
              onJump={onJump}
            />
          ) : null}
          {words.trim() ? (
            // 8 lines of 19 px; a question's footer follows, so its Show more reads as the body's.
            <BotItemClampedText
              text={words}
              clampClassName="max-h-[152px]"
              fade
              quietToggle={waiting || shape.decisions.length > 0}
            />
          ) : null}
          <BotItemCommentImages images={restImages} />
          <BotItemCommentFiles paths={files} />
          {shape.decisions.length > 0 ? (
            <BotItemQuestionLines
              shape={shape}
              askId={event.id}
              heldScopes={
                shape.decisions.length > 1
                  ? shape.decisions.map((_, line) =>
                      botItemHeldAnswerScope(bot, item.uid, event.id, line)
                    )
                  : undefined
              }
              waiting={waiting}
              answers={entry.answers}
              actions={quickReplies}
              onJump={onJump}
              // Ruled off only below something: a question with no body stays under the name.
              className={waiting && shape.body.trim() ? QUESTION_RULE : undefined}
            />
          ) : null}
          {failed ? (
            <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t('bots.items.activity.notSent', 'Not sent.')}</span>
              <button
                type="button"
                className="font-medium text-foreground hover:underline"
                onClick={failed.retry}
              >
                {t('bots.items.activity.retry', 'Retry')}
              </button>
              <button type="button" className="hover:underline" onClick={failed.discard}>
                {t('bots.items.activity.discard', 'Discard')}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** An answer's lines in the ask's order: "↳ 2 of 3 · Question", then the words, then that line's images.
 *  Held, the words wrap in full, a shade quieter; each line grows in as it is added. */
function BotItemAnswerLines({
  answered,
  images,
  lineImages,
  held,
  onJump
}: {
  answered: BotItemAnswered
  images: readonly BotItemCommentImage[]
  /** Per line, the images its [Image #N] name, by their place in `images`. */
  lineImages: readonly (readonly number[])[]
  /** Held here: a line's click opens its answer in the box too. */
  held?: { edit: (line: number) => void }
  onJump?: (target: BotItemJumpTarget) => void
}): React.JSX.Element {
  const t = useTranslate()
  // Lines added after the card shows grow in; the card itself grows in with its first.
  const [shown] = useState(() => new Set(answered.lines.map(({ index }) => index)))
  return (
    <div className="flex flex-col gap-2.5">
      {answered.lines.map(({ index, question, words }, at) => {
        const own = lineImages[at] ?? []
        const text = stripSentImagePromptMarkers(words, images.length).trim()
        return (
          <div key={index} className={held && !shown.has(index) ? 'bot-item-grow-in' : undefined}>
            <button
              type="button"
              className="mb-1 flex max-w-full min-w-0 items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:[&>span:last-child]:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              aria-label={t(
                'bots.items.activity.replyingTo',
                'Replying to: {{question}}. Go to the question',
                { question: question.slice(0, 80) }
              )}
              disabled={!onJump && !held}
              onClick={() => {
                onJump?.({ eventId: answered.askId, line: index })
                held?.edit(index)
              }}
            >
              <CornerDownRight className="size-3 shrink-0" />
              <span className="shrink-0 tabular-nums">
                {t('bots.items.activity.answerPlace', '{{n}} of {{total}} ·', {
                  n: index + 1,
                  total: answered.total
                })}
              </span>
              <span className="min-w-0 truncate">{question}</span>
            </button>
            {!text ? null : held ? (
              <div className="[&>*]:text-foreground/80">
                <BotItemMarkdown text={text} />
              </div>
            ) : (
              <BotItemClampedText text={text} clampClassName="max-h-[152px]" fade />
            )}
            <BotItemCommentImages images={own.map((place) => images[place]!)} />
          </div>
        )
      })}
    </div>
  )
}
