import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { cn } from '@/lib/class-names'
import type { Bot } from '../../../../shared/bot-types'
import { useBotAvatarSrc } from './bot-avatar-image'
import type { BotOnHost } from '@/lib/bot-hosts'
import { botFallback } from '../../../../shared/bots/bot-avatar-fallback'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import { BOT_MASCOT_URLS } from './bot-mascots'
import { useBotPictureGenerating } from './avatar-generation-requests'

/** The bot's picture, else its emoji, else its initial; veiled with a spinner while a new one is being
 *  made for it, from a picker open or closed. */
export function BotAvatar({
  bot,
  className,
  style
}: {
  bot: Pick<Bot, 'id' | 'name' | 'avatar' | 'avatarColor'> & BotOnHost
  className?: string
  style?: React.CSSProperties
}): React.JSX.Element {
  return (
    <BotAvatarTile
      src={useBotAvatarSrc(bot)}
      fallback={botFallback(bot)}
      className={className}
      style={style}
      generating={useBotPictureGenerating(bot)}
    />
  )
}

/** A bot on another computer, by the avatar its mail carried: its mascot or emoji, else its initial
 *  (an upload stays on that computer). */
export function CarriedBotAvatar({
  name,
  avatar,
  className
}: {
  name: string
  avatar: string | null
  className?: string
}): React.JSX.Element {
  const parsed = parseBotAvatar(avatar)
  return (
    <BotAvatarTile
      src={parsed?.kind === 'mascot' ? BOT_MASCOT_URLS[parsed.id] : null}
      fallback={botFallback({ name, avatar })}
      className={className}
    />
  )
}

/** The tile itself, for a picture not yet saved to a bot (the New bot dialog). */
export function BotAvatarTile({
  src,
  fallback,
  className,
  style,
  generating = false
}: {
  src: string | null
  fallback: string
  className?: string
  style?: React.CSSProperties
  /** A new picture is being made: a light veil with a spinner, the current face still showing. */
  generating?: boolean
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      style={style}
      className={cn(
        'relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted text-xs font-semibold text-foreground',
        src && 'border-0 bg-transparent',
        className
      )}
    >
      {src ? (
        <img src={src} alt="" draggable={false} className="size-full object-cover" />
      ) : (
        fallback
      )}
      {generating ? <BotPictureGeneratingVeil /> : null}
    </span>
  )
}

/** Over a picture being replaced by one still being made. */
export function BotPictureGeneratingVeil(): React.JSX.Element {
  return (
    <span className="absolute inset-0 flex items-center justify-center rounded-[inherit] bg-black/40 text-white">
      <LoadingSpinner className="size-1/2 max-h-4 max-w-4" />
    </span>
  )
}
