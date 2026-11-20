// A comment in an item's Activity: one quiet surface for every author, with avatar, name and time, and
// the text as Markdown. An agent's Needs you question is not drawn here: its row and card are chat's
// question's. A reply to a question quotes it, and leads back to it.
import { useContext } from 'react'
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
import { NativeChatMarkdownImageOwnerContext } from '../../native-chat/media/images/native-chat-markdown-image-owner'
import { NativeChatTextAttachments } from '../../native-chat/media/text/NativeChatTextAttachments'
import { BotItemCommentImages } from './BotItemCommentImages'
import { stripSentImagePromptMarkers } from '../../../../../shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import { botInitial } from '../../../../../shared/bots/bot-avatar-fallback'
import { BotAvatar, BotAvatarTile } from '../BotAvatar'
import { BotOwnerAvatar } from '../bot-connector-people'
import { BotItemClampedText } from './BotItemClampedText'
import type { BotItemActivityEntry } from '../../../../../shared/bots/bot-item-activity'
import { botItemActorName } from '../../../../../shared/bots/bot-item-actor-name'

const TIME = { hour: 'numeric', minute: '2-digit' } as const

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

type CommentEntry = Pick<Extract<BotItemActivityEntry, { kind: 'comment' }>, 'event' | 'replyTo'>

/** Marks a card (or a question's card) so a jump can find and focus it. */
export const BOT_ITEM_COMMENT_ATTRIBUTE = 'data-bot-item-comment-id'

export function BotItemCommentCard({
  bot,
  item,
  entry,
  onJump,
  failed,
  textOverride,
  jumpTarget = true
}: {
  bot: Bot
  item: BotItem
  entry: CommentEntry
  /** Scrolls to and focuses another comment, by its event id. */
  onJump?: (eventId: string) => void
  /** A comment sent from the box that the host refused. */
  failed?: { retry: () => void; discard: () => void }
  /** Words to show instead of the event's text (a question's context, without its decisions). */
  textOverride?: string
  /** False when another card (its question's) is where a jump to this event lands. */
  jumpTarget?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const runtimeContext = useContext(NativeChatMarkdownImageOwnerContext)?.runtimeContext ?? null
  const { event, replyTo } = entry
  const images = botItemCommentImages(event.data)
  // Its images show above the words, so the [Image #N] its send wrote go, as in chat's sent messages.
  const text = stripSentImagePromptMarkers(
    textOverride ?? (typeof event.data.text === 'string' ? event.data.text : ''),
    images.length
  )
  const name = botItemActorName(event, item, t)
  const format = uiDateTimeFormat(TIME)
  const jump =
    'rounded-sm outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50'
  return (
    // Opaque under the surface's tint so the Activity rail never shows through. It bleeds past the
    // column so the avatar and time sit on the event rows' glyph and time edges.
    <div className="relative -mx-2 my-1 rounded-[10px] bg-sidebar">
      <div
        {...(jumpTarget ? { [BOT_ITEM_COMMENT_ATTRIBUTE]: event.id } : {})}
        tabIndex={-1}
        role="article"
        aria-label={t('bots.items.activity.commentLabel', '{{name}}, {{time}}', {
          name,
          time: format.format(event.at)
        })}
        className="rounded-[10px] bg-foreground/[0.035] px-2 pb-2 pt-1.5 outline-none focus:ring-2 focus:ring-ring/50 dark:bg-foreground/[0.045]"
      >
        <div className="mb-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <Avatar bot={bot} event={event} name={name} />
          <b className="shrink-0 text-[13px] font-medium text-foreground">{name}</b>
          <span className="ml-auto shrink-0 text-2xs tabular-nums">{format.format(event.at)}</span>
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
          <BotItemCommentImages images={images} />
          {/* Files keep their `@path` in the text, with chat's opener for text-like ones. */}
          <NativeChatTextAttachments
            content={text}
            structured
            runtimeContext={runtimeContext}
            renderText={(shown) =>
              !shown.trim() ? null : (
                // 8 lines of 19 px.
                <BotItemClampedText text={shown} clampClassName="max-h-[152px]" fade />
              )
            }
          />
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
