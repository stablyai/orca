// A comment in an item's Activity: one quiet surface for every author, with avatar, name and time, then
// the text as Markdown, its images and its file links. An agent's Needs you question is a comment too:
// its body and attachments, then its question footer (BotItemQuestionLines). A reply to a question quotes it, and leads back to it.
// While the item waits on it, the asking comment stands out: a Needs you tag by its time, a soft orange
// outline, and its question ruled off from the body. Answered, it reads as any other comment.
import { CornerDownRight } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { cn } from '@/lib/class-names'
import type { Bot } from '../../../../../shared/bot-types'
import {
  botItemCommentImages,
  type BotItem,
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
import type { BotItemActivityEntry } from '../../../../../shared/bots/bot-item-activity'
import { botItemActorName } from '../../../../../shared/bots/bot-item-actor-name'
import { botItemQuestionShape } from '../../../../../shared/bots/bot-item-ask'
import { BotItemQuestionLines } from './BotItemQuestionLines'
import {
  botItemHeldAnswersScope,
  type BotItemQuickReplyActions
} from './use-bot-item-question-steps'

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
  'event' | 'replyTo' | 'answers' | 'byOrder'
> & { waiting?: boolean }

/** Marks a card so a jump can find and focus it. */
export const BOT_ITEM_COMMENT_ATTRIBUTE = 'data-bot-item-comment-id'

export function BotItemCommentCard({
  bot,
  item,
  entry,
  onJump,
  failed,
  quickReplies
}: {
  bot: Bot
  item: BotItem
  entry: CommentEntry
  /** Scrolls to and focuses another comment, by its event id. */
  onJump?: (eventId: string) => void
  /** A comment sent from the box that the host refused. */
  failed?: { retry: () => void; discard: () => void }
  /** On the question the item waits on, until the owner replies. */
  quickReplies?: BotItemQuickReplyActions
}): React.JSX.Element {
  const t = useTranslate()
  const { event, replyTo } = entry
  const waiting = entry.waiting === true
  const images = botItemCommentImages(event.data)
  const shape = botItemQuestionShape(event.data)
  // Its images show after the words, so the [Image #N] its send wrote go, as in chat's sent messages.
  // Its files show as links after them, so their `@path`s go from the words.
  const { words } = botItemCommentFiles(stripSentImagePromptMarkers(shape.body, images.length))
  const { files } = botItemCommentFiles(typeof event.data.text === 'string' ? event.data.text : '')
  const name = botItemActorName(event, item, t)
  const format = uiDateTimeFormat(TIME)
  const jump =
    'rounded-sm outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50'
  return (
    // Opaque under the surface's tint so the Activity rail never shows through. It bleeds past the
    // column so the avatar and time sit on the event rows' glyph and time edges.
    <div className="relative -mx-2 my-1 rounded-[10px] bg-sidebar">
      <div
        {...{ [BOT_ITEM_COMMENT_ATTRIBUTE]: event.id }}
        tabIndex={-1}
        role="article"
        aria-label={t('bots.items.activity.commentLabel', '{{name}}, {{time}}', {
          name,
          time: format.format(event.at)
        })}
        className={cn(
          'rounded-[10px] bg-foreground/[0.035] px-2 pt-1.5 outline-none focus:ring-2 focus:ring-ring/50 dark:bg-foreground/[0.045]',
          // Asking the owner: a soft outline, no fill change, so it stands out when scanning.
          waiting && 'ring-1 ring-agent-question/45 dark:ring-agent-question/60',
          // A question's chips end the card: more room under them.
          shape.decisions.length > 0 ? 'pb-4' : 'pb-2'
        )}
      >
        <div className="mb-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <Avatar bot={bot} event={event} name={name} />
          <b className="min-w-0 truncate text-[13px] font-medium text-foreground">{name}</b>
          {waiting ? <NeedsYouTag /> : null}
          <span className={cn('shrink-0 text-2xs tabular-nums', !waiting && 'ml-auto')}>
            {format.format(event.at)}
          </span>
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
        <div className="pl-7">
          {words.trim() ? (
            // 8 lines of 19 px; a question's footer follows, so its Show more reads as the body's.
            <BotItemClampedText
              text={words}
              clampClassName="max-h-[152px]"
              fade
              quietToggle={waiting || shape.decisions.length > 0}
            />
          ) : null}
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
              actions={quickReplies}
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
