import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { cn } from '@/lib/class-names'
import type { Bot } from '../../../../shared/bot-types'
import { useBotAvatarLook } from './bot-avatar-image'
import type { BotOnHost } from '@/lib/bot-hosts'
import { botFallback } from '../../../../shared/bots/bot-avatar-fallback'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import { BOT_MASCOT_URLS } from './bot-mascots'
import type { BotOutfitArt, BotPictureSize } from './bot-mascot-look'
import { useBotPictureGenerating } from './avatar-generation-requests'
import { AnimatedBotAvatar } from './avatar-packs/AnimatedBotAvatar'
import { useResolvedAvatarPack } from './avatar-packs/use-resolved-avatar-pack'

/** The bot's picture, else its emoji, else its initial; veiled with a spinner while a new one is being
 *  made for it, from a picker open or closed. */
export function BotAvatar({
  bot,
  size,
  className,
  style
}: {
  bot: Pick<Bot, 'id' | 'name' | 'avatar' | 'avatarColor' | 'avatarOutfit'> &
    BotOnHost & { paused?: boolean; folderWorkspaceId?: string | null }
  /** 'large' for a picture over about 48 px, so an outfit draws its large art. */
  size?: BotPictureSize
  className?: string
  style?: React.CSSProperties
}): React.JSX.Element {
  const look = useBotAvatarLook(bot, size)
  const generating = useBotPictureGenerating(bot)
  const animatedPack = useResolvedAvatarPack(bot)
  const fallbackText = botFallback(bot)

  if (animatedPack?.active) {
    return (
      <span
        aria-hidden
        style={style}
        className={cn(
          'relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md border-0 bg-transparent text-xs font-semibold text-foreground',
          className
        )}
      >
        <AnimatedBotAvatar
          pack={animatedPack.pack}
          charIndex={animatedPack.charIndex}
          state={animatedPack.state}
          className="size-full"
          fallback={
            look.src ? (
              <img src={look.src} alt="" draggable={false} className="size-full object-cover" />
            ) : (
              <span className="flex size-full items-center justify-center rounded-[inherit] border border-border bg-muted">
                {fallbackText}
              </span>
            )
          }
        />
        {generating ? <BotPictureGeneratingVeil /> : null}
      </span>
    )
  }

  return (
    <BotAvatarTile
      src={look.src}
      outfit={look.outfit}
      fallback={fallbackText}
      className={className}
      style={style}
      generating={generating}
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
  const fallbackText = botFallback({ name, avatar })
  if (parsed?.kind === 'avatar-pack') {
    return (
      <span
        aria-hidden
        className={cn(
          'relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md border-0 bg-transparent text-xs font-semibold text-foreground',
          className
        )}
      >
        <AnimatedBotAvatar
          pack={parsed.pack}
          charIndex={parsed.charIndex}
          state="idle"
          className="size-full"
          fallback={
            <span className="flex size-full items-center justify-center rounded-[inherit] border border-border bg-muted">
              {fallbackText}
            </span>
          }
        />
      </span>
    )
  }
  return (
    <BotAvatarTile
      src={parsed?.kind === 'mascot' ? BOT_MASCOT_URLS[parsed.id] : null}
      fallback={fallbackText}
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
  generating = false
}: {
  src: string | null
  fallback: string
  outfit?: BotOutfitArt | null
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
      {src && outfit ? <OutfitArt art={outfit} /> : null}
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
