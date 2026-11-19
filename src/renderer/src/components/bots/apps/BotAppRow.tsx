import React from 'react'
import { cn } from '@/lib/class-names'
import { composioLogoUrl } from '../../../../../shared/composio/composio-apps'
import { LOGO_TILES } from './brand-logo-tiles'

/** A coloured tile's mark colour and its hairline on a dark page; the white tile otherwise. */
export function brandTileClass(tile: string | undefined): string {
  return tile
    ? 'text-brand-mark dark:outline-1 dark:-outline-offset-1 dark:outline-white/14'
    : 'bg-brand-mark text-brand-mark-foreground'
}

/** A Composio app's logo (Orca's bundled icon first) and, for a full-square one, the colour of the tile it fills. */
export function composioLogo(
  slug: string | undefined,
  logo?: string | null
): { src: string; fill: string | undefined } {
  return {
    src: (slug && LOGO_TILES.filled[slug]) || logo || composioLogoUrl(slug ?? ''),
    fill: slug ? LOGO_TILES.composio[slug] : undefined
  }
}

/** An app's mark on its tile: the colour its brand sits on (white unless LOGO_TILES says), plain icons on muted. */
export function BotAppLogo({
  slug,
  logo,
  icon,
  plain = false,
  tile,
  size = 'md'
}: {
  /** A Composio app's logo, by its slug or Composio's own URL. */
  slug?: string
  logo?: string | null
  /** An Orca connector's own icon. */
  icon?: React.ReactNode
  /** A muted tile for a generic icon (Add by URL). */
  plain?: boolean
  /** A bundled mark's tile colour from LOGO_TILES.brand; white without one. */
  tile?: string
  /** md: a list row; lg: a setup step's heading. */
  size?: 'sm' | 'md' | 'lg'
}): React.JSX.Element {
  const image = icon || !(slug || logo) ? undefined : composioLogo(slug, logo)
  const fill = image?.fill
  const background = fill ?? tile
  return (
    <span
      data-size={size}
      style={{ backgroundColor: background }}
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg data-[size=lg]:size-11 data-[size=lg]:rounded-xl data-[size=md]:size-8 data-[size=sm]:size-5 data-[size=sm]:rounded',
        plain ? 'bg-muted text-muted-foreground' : brandTileClass(background)
      )}
    >
      {icon ??
        (image ? (
          <img
            src={image.src}
            alt=""
            draggable={false}
            className={cn(
              'object-contain',
              fill
                ? 'size-full'
                : size === 'lg'
                  ? 'size-6.5'
                  : size === 'sm'
                    ? 'size-3.5'
                    : 'size-5'
            )}
          />
        ) : null)}
    </span>
  )
}

/** One app in Add to <bot>: its mark, name and one line, then its one action. */
export function BotAppRow({
  logo,
  name,
  tag,
  line,
  action
}: {
  logo: React.ReactNode
  name: string
  /** Muted after the name, e.g. "via Composio" where routes mix. */
  tag?: string
  line: React.ReactNode
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-accent/40">
      {logo}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-sm leading-[18px] font-medium whitespace-nowrap">
          {name}
          {tag ? <span className="text-xs font-normal text-muted-foreground">{tag}</span> : null}
        </span>
        <span className="block truncate text-xs leading-4 text-muted-foreground">{line}</span>
      </span>
      {action}
    </li>
  )
}

/** A list's caption, with its count. */
export function BotAppCaption({
  id,
  title,
  count,
  icon
}: {
  id?: string
  title: string
  count?: number
  icon?: React.ReactNode
}): React.JSX.Element {
  return (
    <h3
      id={id}
      className="flex items-center gap-1.5 px-2 pt-3.5 pb-1 text-2xs font-semibold text-muted-foreground"
    >
      {icon}
      <span className="min-w-0 truncate" title={title}>
        {title}
      </span>
      {count !== undefined ? (
        <span className="shrink-0 font-medium tabular-nums">{count}</span>
      ) : null}
    </h3>
  )
}
