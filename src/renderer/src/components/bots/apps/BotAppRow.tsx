import React, { useContext } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { composioLogoUrl } from '../../../../../shared/composio/composio-apps'
import { COMPOSIO_DARK_MARKS, LOGO_TILES } from './brand-logo-tiles'
import { BotAppLogoBadge } from './BotAppStepParts'

/** A coloured tile's mark colour and its hairline on a dark page; the white tile, with its hairline on a
 *  light page, otherwise. */
export function brandTileClass(tile: string | undefined): string {
  return tile
    ? 'text-brand-mark dark:outline-1 dark:-outline-offset-1 dark:outline-white/14'
    : 'bg-brand-mark text-brand-mark-foreground outline-1 -outline-offset-1 outline-black/8 dark:outline-0'
}

/** A Composio app's logo (Orca's bundled icon first) and, for a full-square one, the colour of the tile it fills. */
export function composioLogo(
  slug: string | undefined,
  logo?: string | null
): { src: string; fill: string | undefined; darkMark: boolean } {
  return {
    src: (slug && LOGO_TILES.filled[slug]) || logo || composioLogoUrl(slug ?? ''),
    fill: slug ? LOGO_TILES.composio[slug] : undefined,
    darkMark: slug ? COMPOSIO_DARK_MARKS.has(slug) : false
  }
}

/**
 * Inside a connector list's row: every logo is its bare mark in one 20 px box, with no tile, so the rows' icons read
 * as one size. A logo that is a full square of colour (LOGO_TILES.composio) is that square at 20 px.
 */
export const BotLogoBare = React.createContext(false)

/** A bare logo's box; see BotLogoBare. */
export const BARE_LOGO_BOX = 'flex size-5 shrink-0 items-center justify-center'

/** A logo Composio serves, bare (see BotLogoBare): a full square of colour at 20 px, else its mark. */
export function BareComposioLogo({
  src,
  fill,
  darkMark
}: ReturnType<typeof composioLogo>): React.JSX.Element {
  return fill ? (
    <span
      style={{ backgroundColor: fill }}
      className={cn(
        BARE_LOGO_BOX,
        'overflow-hidden rounded-[5px] dark:outline-1 dark:-outline-offset-1 dark:outline-white/14'
      )}
    >
      <img src={src} alt="" draggable={false} className="size-full object-contain" />
    </span>
  ) : (
    <span className={BARE_LOGO_BOX}>
      <img
        src={src}
        alt=""
        draggable={false}
        className={cn('size-5 object-contain', darkMark && 'dark:brightness-0 dark:invert')}
      />
    </span>
  )
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
  /** sm: a face in a stack; md: a connector row; catalog: Add apps' list rows; lg: a setup step's heading. */
  size?: 'sm' | 'md' | 'catalog' | 'lg'
}): React.JSX.Element {
  const bare = useContext(BotLogoBare)
  const image = icon || !(slug || logo) ? undefined : composioLogo(slug, logo)
  const fill = image?.fill
  const background = fill ?? tile
  if (bare) {
    return image ? (
      <BareComposioLogo {...image} />
    ) : (
      <span className={cn(BARE_LOGO_BOX, plain ? 'text-muted-foreground' : 'text-foreground')}>
        {icon}
      </span>
    )
  }
  return (
    <span
      data-size={size}
      style={{ backgroundColor: background }}
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg data-[size=catalog]:size-10 data-[size=lg]:size-11 data-[size=lg]:rounded-xl data-[size=md]:size-8 data-[size=sm]:size-5 data-[size=sm]:rounded',
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

/** One app in Add apps: its mark (with a check once the bot has it), name and one line, then its actions. */
export function BotAppRow({
  logo,
  added = false,
  name,
  tag,
  line,
  action
}: {
  logo: React.ReactNode
  added?: boolean
  name: string
  /** Muted after the name, e.g. "via Composio" where routes mix. */
  tag?: string
  line: string
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="@container/app-row flex h-15 min-w-0 items-center gap-3 rounded-lg px-2 transition-colors hover:bg-accent/40 has-[+li[data-github-recovery]]:col-span-full">
      <span className="relative shrink-0">
        {logo}
        {added ? <BotAppLogoBadge kind="added" size="sm" /> : null}
      </span>
      {/* A floor for the line, so a long action label (de) truncates before the line vanishes. */}
      <span className="min-w-24 flex-1">
        <span className="flex min-w-0 items-center gap-1.5 text-sm leading-[18px] font-medium">
          <span className="truncate" title={name}>
            {name}
          </span>
          {tag ? (
            <Badge variant="referenceLabel" className="max-w-[45%]">
              <span className="truncate" title={tag}>
                {tag}
              </span>
            </Badge>
          ) : null}
        </span>
        <span className="block truncate text-xs leading-4 text-muted-foreground" title={line}>
          {line}
        </span>
      </span>
      {action}
    </li>
  )
}

/** A row's pill action: Add, Manage, Set up. */
export function BotAppRowButton({
  variant = 'secondary',
  ...props
}: React.ComponentProps<typeof Button>): React.JSX.Element {
  return <Button variant={variant} size="pill" {...props} />
}

/** Rows follow reading order across two columns when the list is wide enough. */
export function BotAppGrid({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <ul className="grid grid-cols-1 gap-x-4 gap-y-0.5 @min-[700px]:grid-cols-2">{children}</ul>
}

/** A list's caption, with its count and an optional action at its end. */
export function BotAppCaption({
  id,
  title,
  count,
  action
}: {
  id?: string
  title: string
  count?: number
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-h-6 items-center justify-between gap-1.5 px-2 pt-4 pb-1 text-2xs text-muted-foreground">
      <h3 id={id} className="flex min-w-0 items-center gap-1.5 font-semibold">
        <span className="min-w-0 truncate" title={title}>
          {title}
        </span>
        {count !== undefined ? (
          <span className="shrink-0 font-medium tabular-nums">{count}</span>
        ) : null}
      </h3>
      {action}
    </div>
  )
}
