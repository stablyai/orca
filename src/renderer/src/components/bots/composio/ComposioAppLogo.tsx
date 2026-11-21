import React, { useContext } from 'react'
import { cn } from '@/lib/class-names'
import { BareComposioLogo, BotLogoBare, brandTileClass, composioLogo } from '../apps/BotAppRow'

/** An app's own logo from Composio (no key needed) on its brand's tile; a full-square logo fills it. */
export function ComposioAppLogo({
  slug,
  logo,
  size = 'sm'
}: {
  slug: string
  logo?: string | null
  /** sm: a chip in a list of names; md: a catalog row; lg: a card's avatar. */
  size?: 'sm' | 'md' | 'lg'
}): React.JSX.Element {
  const bare = useContext(BotLogoBare)
  const image = composioLogo(slug, logo)
  const { src, fill: tile } = image
  if (bare) {
    return <BareComposioLogo {...image} />
  }
  return (
    <span
      data-size={size}
      style={{ backgroundColor: tile }}
      className={cn(
        'group/logo flex shrink-0 items-center justify-center overflow-hidden rounded-md data-[size=lg]:size-8 data-[size=md]:size-7 data-[size=sm]:size-5 data-[size=sm]:rounded',
        brandTileClass(tile)
      )}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        className={
          tile
            ? 'size-full'
            : 'size-5 group-data-[size=md]/logo:size-4.5 group-data-[size=sm]/logo:size-3.5'
        }
      />
    </span>
  )
}
