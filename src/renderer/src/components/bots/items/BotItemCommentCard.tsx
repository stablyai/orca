// A comment in an item's Activity: a card with its author's avatar, name and time, and the text as
// Markdown. The bot's open question stays outlined with Waiting on you until it is answered.
import { useContext } from 'react'
import { Check, CornerDownRight } from 'lucide-react'
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
import { BotItemMarkdown } from './BotItemMarkdown'
import { BotItemStatusIcon } from './BotItemStatusIcon'
import type { BotItemQuestionState } from '../../../../../shared/bots/bot-item-activity'
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

export function BotItemCommentCard({
  bot,
  item,
  event,
  question,
  onReply
}: {
  bot: Bot
  item: BotItem
  event: BotItemEvent
  question: BotItemQuestionState | null
  onReply: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const runtimeContext = useContext(NativeChatMarkdownImageOwnerContext)?.runtimeContext ?? null
  const mine = event.actor.kind === 'owner'
  const images = botItemCommentImages(event.data)
  // Its images show above the words, so the [Image #N] its send wrote go, as in chat's sent messages.
  const text = stripSentImagePromptMarkers(
    typeof event.data.text === 'string' ? event.data.text : '',
    images.length
  )
  const name = botItemActorName(event, item, t)
  const time = (
    <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
      {uiDateTimeFormat(TIME).format(event.at)}
    </span>
  )
  return (
    // Opaque under the card's tint so the Activity rail never shows through.
    <div className="relative my-2 rounded-[10px] bg-sidebar">
      <div
        data-bot-item-comment={mine ? 'mine' : 'bot'}
        className={cn(
          'rounded-[10px] border px-3 pb-2.5 pt-2',
          mine ? 'border-chat-user-border bg-chat-user-surface' : 'border-border bg-foreground/3',
          question === 'open' && 'border-foreground/25'
        )}
      >
        {question === 'open' ? (
          <div className="mb-2 flex items-center gap-2 border-b border-border pb-2">
            <span className="flex items-center gap-1.5 text-2xs font-medium text-foreground">
              <BotItemStatusIcon status="needs_you" />
              {t('bots.items.activity.waitingOnYou', 'Waiting on you')}
            </span>
            <button
              type="button"
              className="ml-auto flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
              onClick={onReply}
            >
              <CornerDownRight className="size-3" />
              {t('bots.items.activity.reply', 'Reply')}
            </button>
          </div>
        ) : null}
        <div className="mb-1.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <Avatar bot={bot} event={event} name={name} />
          <b className="shrink-0 text-[13px] font-medium text-foreground">{name}</b>
          {question ? (
            <span className="min-w-0 truncate">
              {question === 'open'
                ? t('bots.items.activity.asksYou', 'asks you')
                : t('bots.items.activity.askedYou', 'asked you')}
            </span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {question === 'answered' ? (
              <span className="flex items-center gap-1 text-2xs">
                <Check className="size-3" />
                {t('bots.items.activity.answered', 'Answered')}
              </span>
            ) : null}
            {time}
          </span>
        </div>
        <BotItemCommentImages images={images} />
        {/* Files keep their `@path` in the text, with chat's opener for text-like ones. */}
        <NativeChatTextAttachments
          content={text}
          structured
          runtimeContext={runtimeContext}
          renderText={(shown) =>
            !shown.trim() ? null : question === 'open' ? (
              <BotItemMarkdown text={shown} />
            ) : (
              // 12 lines of 19 px.
              <BotItemClampedText text={shown} clampClassName="max-h-[228px]" fade />
            )
          }
        />
      </div>
    </div>
  )
}
