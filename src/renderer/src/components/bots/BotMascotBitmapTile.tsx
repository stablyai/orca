// A mascot drawn from its bundled bitmap on a tile of its color, as mobile draws it. The SVG's blur
// filters cost new GPU programs at each size drawn, which a carousel scaling 20 of them pays on first open.
import type React from 'react'
import { cn } from '@/lib/class-names'
import { OutfitArt } from './BotAvatar'
import type { BotOutfitArt } from './bot-mascot-look'
import type { BotMascotId } from '../../../../shared/bot-avatar'
import {
  DEFAULT_BOT_AVATAR_COLOR,
  isDarkBotAvatarColor
} from '../../../../shared/bots/bot-avatar-color'

const BITMAPS = import.meta.glob<string>('../../../../shared/bot-mascots/*.webp', {
  query: '?url',
  import: 'default',
  eager: true
})

function bitmap(name: string): string | undefined {
  return BITMAPS[`../../../../shared/bot-mascots/${name}.webp`]
}

export function BotMascotBitmapTile({
  id,
  color,
  face,
  outfit,
  className
}: {
  id: BotMascotId
  color: string | null | undefined
  /** The mascot an outfit redraws (the eyes looking down), baked like the bitmaps here. */
  face?: string | null
  /** Drawn over the mascot, apart from the tile so a new color never redraws it. */
  outfit?: BotOutfitArt | null
  className?: string
}): React.JSX.Element {
  const tile = color ?? DEFAULT_BOT_AVATAR_COLOR
  const rim = isDarkBotAvatarColor(tile) ? bitmap(`${id}-rim`) : undefined
  return (
    <span
      aria-hidden
      style={{ backgroundColor: tile }}
      className={cn('relative block shrink-0 overflow-hidden', className)}
    >
      {rim ? (
        <img src={rim} alt="" draggable={false} className="absolute inset-0 size-full" />
      ) : null}
      <img
        src={face ?? bitmap(id)}
        alt=""
        draggable={false}
        className="absolute inset-0 size-full"
      />
      {outfit ? <OutfitArt art={outfit} /> : null}
    </span>
  )
}
