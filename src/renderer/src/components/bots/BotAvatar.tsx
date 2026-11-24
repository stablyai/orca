import { cn } from '@/lib/class-names'
import type { Bot } from '../../../../shared/bot-types'
import { useBotAvatarLook } from './bot-avatar-image'
import type { BotOnHost } from '@/lib/bot-hosts'
import { botFallback } from '../../../../shared/bots/bot-avatar-fallback'
import { BOT_SHAPE_AVATAR, parseBotAvatar } from '../../../../shared/bot-avatar'
import { AnimatedBotShape } from './AnimatedBotShape'
import { BOT_MASCOT_URLS } from './bot-mascots'
import type { BotOutfitArt, BotPictureSize } from './bot-mascot-look'

/** The bot's picture, else its emoji, else its initial. */
export function BotAvatar({
  bot,
  size,
  className,
  style,
  shapeState
}: {
  bot: Pick<Bot, 'id' | 'name' | 'avatar' | 'avatarColor' | 'avatarOutfit'> & BotOnHost
  /** 'large' for a picture over about 48 px, so an outfit draws its large art. */
  size?: BotPictureSize
  className?: string
  style?: React.CSSProperties
  shapeState?: 'idle' | 'working'
}): React.JSX.Element {
  const look = useBotAvatarLook(bot, size)
  return (
    <BotAvatarTile
      src={look.src}
      outfit={look.outfit}
      fallback={botFallback(bot)}
      className={className}
      style={style}
    >
      {shapeState && bot.avatar === BOT_SHAPE_AVATAR && look.src ? (
        <AnimatedBotShape src={look.src} color={bot.avatarColor} state={shapeState} />
      ) : null}
    </BotAvatarTile>
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

/** The tile itself, for a picture not yet saved to a bot (the New bot dialog); `outfit` draws over it. */
export function BotAvatarTile({
  src,
  fallback,
  outfit,
  className,
  style,
  children
}: {
  src: string | null
  fallback: string
  outfit?: BotOutfitArt | null
  className?: string
  style?: React.CSSProperties
  children?: React.ReactNode
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
      {children ??
        (src ? (
          <img src={src} alt="" draggable={false} className="size-full object-cover" />
        ) : (
          fallback
        ))}
      {src && outfit ? <OutfitArt art={outfit} /> : null}
    </span>
  )
}

// The art's place on the 128 px tile, as a share of the tile, so it fits any tile size.
export function OutfitArt({ art }: { art: BotOutfitArt }): React.JSX.Element {
  const [x, y, width, height] = art.at.map((v) => `${(v / 128) * 100}%`)
  return (
    <img
      src={art.src}
      alt=""
      // Off the paint path: the mascot draws at once and its outfit joins when decoded.
      decoding="async"
      draggable={false}
      style={{ left: x, top: y, width, height }}
      className="pointer-events-none absolute max-w-none"
    />
  )
}
