// A comment in an item's Activity: one quiet surface for every author, with avatar, name and time, then
// the text as Markdown, its images and its file links. An agent's Needs you question is a comment too:
// its body and attachments, then its question footer (BotItemQuestionLines). A reply to a question quotes it, and leads back to it.
// While the item waits on a one-question ask, its context is cut to 2 lines over the bold question and its
// reply rows; the item's status already says Needs you. Answered, a one-question ask folds to
// "Answered <answer>", which opens the whole comment again.
import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, CornerDownRight } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { Bot } from '../../../../../shared/bot-types'
import {
  botItemCommentImages,
  type BotItem,
  type BotItemEvent
} from '../../../../../shared/bots/bot-items'
import { botItemCommentFiles } from '../../../../../shared/bots/bot-item-comment-files'
import {
  NativeChatMessageTimestamp,
  useNativeChatMessageTimeLabel
} from '../../native-chat/messages/rows/NativeChatMessageTimestamp'
import { BotItemCommentImages } from './BotItemCommentImages'
import { BotItemCommentFiles } from './BotItemCommentFiles'
import { stripSentImagePromptMarkers } from '../../../../../shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import { botInitial } from '../../../../../shared/bots/bot-avatar-fallback'
import { BotAvatar, BotAvatarTile } from '../BotAvatar'
import { BotOwnerAvatar } from '../bot-connector-people'
import { BotItemClampedText } from './BotItemClampedText'
import { BotItemMarkdown } from './BotItemMarkdown'
import type { BotItemActivityEntry } from '../../../../../shared/bots/bot-item-activity'
import { botItemActorName } from '../../../../../shared/bots/bot-item-actor-name'
import { botItemQuestionShape } from '../../../../../shared/bots/bot-item-ask'
import { botItemAnswerWords } from '../../../../../shared/bots/bot-item-answer-lines'
import { BotItemQuestionLines } from './BotItemQuestionLines'
import { BOT_ITEM_COMMENT_ATTRIBUTE } from './bot-item-comment-reveal'
import { botItemHeldAnswersScope } from './bot-item-held-answers'
import type { BotItemQuickReplyActions } from './use-bot-item-question-steps'

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
  'event' | 'replyTo' | 'answers' | 'byOrder' | 'ended' | 'beside'
> & { waiting?: boolean }

export function BotItemCommentCard({
  bot,
  item,
  entry,
  onJump,
  liveAskId,
  failed,
  quickReplies
}: {
  bot: Bot
  item: BotItem
  entry: CommentEntry
  /** Scrolls to and focuses another comment, by its event id. */
  onJump?: (eventId: string) => void
  /** The ask the item waits on now, which a replaced ask leads to. */
  liveAskId?: string | null
  /** A comment sent from the box that the host refused. */
  failed?: { retry: () => void; discard: () => void }
  /** On the question the item waits on, until the owner replies. */
  quickReplies?: BotItemQuickReplyActions
}): React.JSX.Element {
  const t = useTranslate()
  const { event, replyTo } = entry
  const waiting = entry.waiting === true
  // Waited on while shown: whole until this view unmounts (Show less still folds it).
  const [askedHere, setAskedHere] = useState(waiting)
  if (waiting && !askedHere) {
    setAskedHere(true)
  }
  const [unfolded, setUnfolded] = useState(false)
  const images = botItemCommentImages(event.data)
  const shape = botItemQuestionShape(event.data)
  const total = shape.decisions.length
  const sent = quickReplies?.sent?.get(event.id)
  // Per line, its answer: a comment's, or a send's on its way.
  const lineWords = shape.decisions.map((_, index) => {
    const answer = entry.answers?.[index]
    return answer ? botItemAnswerWords(shape, index, answer.data) : (sent?.[index] ?? null)
  })
  const answeredCount = lineWords.filter(Boolean).length
  // Answered by comments the host has: a failed send's picks still show on their lines, but aren't these.
  const postedCount = shape.decisions.filter((_, index) => entry.answers?.[index]).length
  const steps = quickReplies?.steps?.askId === event.id ? quickReplies.steps : null
  // Answered: one question once it has its answer; several once Send posted (or they all have one).
  const done =
    total === 1
      ? lineWords[0] !== null
      : total > 1 &&
        (waiting
          ? // A send that failed keeps its lines closed but isn't sent: its Retry is in the Activity.
            steps !== null && steps.lines.length === 0 && (steps.sending || postedCount === total)
          : answeredCount === total || (entry.ended === 'skipped' && answeredCount > 0))
  const folded = done && !unfolded
  const body = useRef<HTMLDivElement | null>(null)
  const summary = useRef<HTMLButtonElement | null>(null)
  const article = useRef<HTMLDivElement | null>(null)
  // Folding hides what had focus (Send, a reply row, Other…): focus goes to the summary instead, so
  // the pane's keys keep working. A send that fails unfolds it again: focus goes to the card.
  const wasFolded = useRef(folded)
  useLayoutEffect(() => {
    const active = document.activeElement
    // Only when it folds here: a card already folded as the item opens never takes focus.
    if (
      folded &&
      !wasFolded.current &&
      (active === document.body || (active && body.current?.contains(active)))
    ) {
      summary.current?.focus({ preventScroll: true })
    } else if (!folded && wasFolded.current && active === document.body) {
      article.current?.focus({ preventScroll: true })
    }
    wasFolded.current = folded
  }, [folded])
  // The open ask with reply rows: its context cut short over them.
  const rows = waiting && quickReplies !== undefined && !done && (total === 1 || steps !== null)
  // Its images show after the words, so the [Image #N] its send wrote go, as in chat's sent messages.
  // Its files show as links after them, so their `@path`s go from the words.
  const { words } = botItemCommentFiles(
    stripSentImagePromptMarkers(entry.beside ?? shape.body, images.length)
  )
  const { files } = botItemCommentFiles(typeof event.data.text === 'string' ? event.data.text : '')
  const name = botItemActorName(event, item, t)
  const fullTime = useNativeChatMessageTimeLabel(event.at)
  const jump =
    'rounded-sm outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50'
  return (
    // Opaque under the surface's tint so the Activity rail never shows through. It bleeds past the
    // column so the avatar and time sit on the event rows' glyph and time edges.
    <div className="relative -mx-2 my-1 rounded-[10px] bg-sidebar">
      <div
        ref={article}
        {...{ [BOT_ITEM_COMMENT_ATTRIBUTE]: event.id }}
        tabIndex={-1}
        role="article"
        aria-label={t('bots.items.activity.commentLabel', '{{name}}, {{time}}', {
          name,
          time: fullTime ?? ''
        })}
        className={cn(
          // A hairline (an inset ring, so its size and padding hold) and, in dark, the muted surface: a
          // tint alone lost the card's edge on the page.
          'rounded-[10px] bg-foreground/[0.035] px-2 pt-1.5 inset-ring inset-ring-border outline-none focus:ring-2 focus:ring-ring/50 dark:bg-muted',
          // Shown from "Replying to": a full ring and tint, easing out as it ends.
          'data-[flash=on]:bg-foreground/8 data-[flash=on]:ring-2 data-[flash=on]:ring-ring data-[flash=fading]:transition-[box-shadow,background-color] data-[flash=fading]:duration-600 dark:data-[flash=on]:bg-foreground/8',
          // A question's rows end the card: more room under them.
          shape.decisions.length > 0 && !folded ? (rows ? 'pb-2' : 'pb-4') : 'pb-2'
        )}
      >
        <div className="mb-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
          <div className="flex min-w-0 max-w-full flex-auto items-center gap-2">
            <Avatar bot={bot} event={event} name={name} />
            <b className="min-w-0 truncate text-[13px] font-medium text-foreground">{name}</b>
          </div>
          <NativeChatMessageTimestamp
            timestamp={event.at}
            className="ml-auto shrink-0 text-2xs text-muted-foreground"
          />
        </div>
        {replyTo ? (
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
            onClick={() => onJump?.(replyTo.eventId)}
          >
            <CornerDownRight className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{replyTo.text}</span>
          </button>
        ) : null}
        {folded ? (
          <button
            type="button"
            aria-expanded={false}
            title={total === 1 ? `${shape.decisions[0]!.question}: ${lineWords[0]}` : undefined}
            className="group/fold -mx-1 flex w-[calc(100%+var(--spacing)*2)] min-w-0 items-center gap-1 rounded-sm px-1 text-left text-[13px] leading-[19px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            ref={summary}
            onClick={() => {
              setUnfolded(true)
              // The summary goes; focus stays in the pane, on the card it opened.
              article.current?.focus({ preventScroll: true })
            }}
          >
            {total === 1 ? (
              <>
                <span className="shrink-0">{t('bots.items.ask.answered', 'Answered')}</span>
                <span className="min-w-0 truncate font-medium text-foreground">{lineWords[0]}</span>
              </>
            ) : (
              <span className="min-w-0 truncate">
                {t('bots.items.ask.sentCount', 'Sent {{count}} of {{total}}', {
                  count: answeredCount,
                  total
                })}
              </span>
            )}
            <ChevronRight className="size-3.5 shrink-0 opacity-0 group-hover/fold:opacity-100 group-focus-visible/fold:opacity-100" />
          </button>
        ) : null}
        {/* An open ask's rows, and its folded line, start on the avatar's edge, as wide as the card allows. */}
        <div ref={body} className={cn(rows ? undefined : 'pl-7', folded && 'hidden')}>
          {!words.trim() ? null : rows ? (
            // Cut to 2 lines: the question and its rows stay in view; Show more opens the rest.
            <BotItemClampedText
              text={words}
              clampClassName="line-clamp-2"
              quietToggle
              // On the card's edge: list markers stay inside it.
              className="mb-2.5 text-muted-foreground [&_*]:text-muted-foreground [&_ol]:pl-4 [&_ul]:pl-4"
            />
          ) : waiting ? (
            // Whole while the item waits on its question: its choices read against all of it.
            <BotItemMarkdown text={words} />
          ) : (
            // 8 lines of 19 px; a question's footer follows, so its Show more reads as the body's.
            <BotItemClampedText
              text={words}
              clampClassName="max-h-[152px]"
              fade
              quietToggle={shape.decisions.length > 0}
              startOpen={askedHere}
            />
          )}
          <BotItemCommentImages images={images} />
          <BotItemCommentFiles paths={files} />
          {shape.decisions.length > 0 ? (
            <BotItemQuestionLines
              shape={shape}
              askId={event.id}
              heldScope={
                shape.decisions.length > 1
                  ? botItemHeldAnswersScope(bot, item.uid, event.id)
                  : undefined
              }
              waiting={waiting}
              answers={entry.answers}
              byOrder={entry.byOrder}
              ended={entry.ended}
              onShowLive={
                onJump && liveAskId && liveAskId !== event.id ? () => onJump(liveAskId) : undefined
              }
              actions={quickReplies}
              className={rows ? '' : undefined}
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
