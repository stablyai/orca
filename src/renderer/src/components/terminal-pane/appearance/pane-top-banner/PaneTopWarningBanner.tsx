import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TriangleAlert, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

/** Stacks the pane's banners top to bottom and reserves their total height for the terminal. */
function layoutPaneTopBanners(pane: HTMLElement, leaving?: HTMLElement): void {
  let offset = 0
  let count = 0
  for (const banner of pane.querySelectorAll<HTMLElement>(':scope > .pane-top-banner')) {
    if (banner === leaving) {
      continue
    }
    banner.style.setProperty('--orca-pane-top-banner-offset', `${offset}px`)
    offset += banner.offsetHeight
    count += 1
  }
  if (count === 0) {
    pane.style.removeProperty('--orca-pane-top-banner-height')
  } else {
    pane.style.setProperty('--orca-pane-top-banner-height', `${offset}px`)
  }
}

/** The tab's pane-title overlay: a sibling layer of the panes that draws each pane's header. */
function paneTitleLayer(pane: HTMLElement): HTMLElement | null {
  return (
    pane
      .closest('[data-terminal-overlay-tab-id]')
      ?.querySelector<HTMLElement>(':scope > .pane-title-overlay-layer') ?? null
  )
}

/** A pane without a title bar floats its controls over its top row, from that overlay layer. */
function floatingPaneControls(pane: HTMLElement, layer: HTMLElement | null): HTMLElement | null {
  const leafId = pane.dataset.leafId
  return leafId && layer
    ? layer.querySelector<HTMLElement>(
        `.pane-title-bar[data-chromeless][data-pane-title-leaf-id="${CSS.escape(leafId)}"] .pane-title-actions`
      )
    : null
}

/** How far those controls reach in from the pane's right edge, so a quiet banner's action can clear them. */
function measureControlsInset(banner: HTMLElement, controls: HTMLElement | null): void {
  const bar = controls?.closest('.pane-title-bar')
  // Why from the bar's own edge: the overlay repositions after the pane resizes, so page coordinates can be a frame stale.
  const inset =
    controls && bar ? bar.getBoundingClientRect().right - controls.getBoundingClientRect().left : 0
  banner.style.setProperty('--orca-pane-top-banner-controls-inset', `${Math.ceil(inset)}px`)
}

/** Reserves the banner's height at the top of its pane so the terminal refits below it. */
function useReservePaneTopSpace(): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const banner = ref.current
    const pane = banner?.parentElement
    if (!banner || !pane) {
      return
    }
    const layer = paneTitleLayer(pane)
    // Why the whole pane: two banners can share it, so each one's height moves the ones below.
    const reserve = (): void => {
      layoutPaneTopBanners(pane)
      measureControlsInset(banner, floatingPaneControls(pane, layer))
    }
    const resizes = new ResizeObserver(reserve)
    resizes.observe(banner)
    // Why watch the overlay: its header can mount after this banner, gain or lose its title bar, or add
    // Hand off and Continue in chat once the agent is detected.
    const headers = new MutationObserver(reserve)
    if (layer) {
      headers.observe(layer, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-chromeless']
      })
    }
    reserve()
    return () => {
      headers.disconnect()
      resizes.disconnect()
      // Why exclude this banner: React runs this before it takes the node out of the pane.
      layoutPaneTopBanners(pane, banner)
    }
  }, [])
  return ref
}

export function PaneBannerLearnMore({ onClick }: { onClick: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <button
      type="button"
      className="text-foreground underline underline-offset-2 hover:text-foreground/80"
      onClick={onClick}
    >
      {t('terminal.paneTopBanner.learnMore', 'Learn more')}
    </button>
  )
}

/** `quiet` is one muted line on the pane's own background, for state the user may ignore. */
type PaneTopBannerTone = 'warning' | 'neutral' | 'accent' | 'quiet'

const TONE_CLASSES: Record<
  Exclude<PaneTopBannerTone, 'quiet'>,
  { stripClass: string; iconClass: string }
> = {
  warning: {
    stripClass:
      'border-status-warning-border bg-background bg-[linear-gradient(var(--status-warning-background),var(--status-warning-background))]',
    iconClass: 'text-status-warning'
  },
  neutral: {
    stripClass: 'border-border bg-card',
    iconClass: 'text-muted-foreground'
  },
  accent: {
    stripClass:
      'border-theme-accent/30 bg-background bg-[linear-gradient(color-mix(in_srgb,var(--color-theme-accent)_10%,transparent),color-mix(in_srgb,var(--color-theme-accent)_10%,transparent))]',
    iconClass: 'text-theme-accent'
  }
}

export type PaneTopBannerProps = {
  title: React.ReactNode
  /** Moves the live region to one hidden node that announces this; pass it (empty until there is news) in every phase so the node persists. */
  announcement?: string
  body?: React.ReactNode
  tone?: PaneTopBannerTone
  /** Replaces the warning icon; neutral and accent show none without it. */
  icon?: LucideIcon
  /** A short label set before the title, e.g. what kind of pane this is. */
  badge?: string
  primaryAction: React.ReactNode
  /** Quiet tone only: `start` sets the action right after the title, clear of controls over the pane's top-right corner. */
  actionPlacement?: 'start' | 'end'
  /** Quiet tone only: the share of time left, drawn as a line along the bottom edge. */
  progress?: number
  onDismiss?: () => void
  onDontShowAgain?: () => void
  onShown?: () => void
}

/** The strip across the top of a terminal pane, with its actions and optional Dismiss; neutral is plain state, without the warning icon. */
export function PaneTopWarningBanner(props: PaneTopBannerProps): React.JSX.Element {
  const ref = useReservePaneTopSpace()
  return <PaneTopBanner {...props} ref={ref} className="pane-top-banner" />
}

function BannerLiveRegion({ announcement }: { announcement: string }): React.JSX.Element {
  const [primed, setPrimed] = useState(false)

  useEffect(() => {
    // A running worker can finish before Chromium registers the empty live region.
    let timeout: number | undefined
    const frame = requestAnimationFrame(() => {
      timeout = window.setTimeout(() => setPrimed(true), 150)
    })
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timeout)
    }
  }, [])

  return (
    <span role="status" className="sr-only">
      {primed ? announcement : ''}
    </span>
  )
}

/** The pane-top banner's look without the terminal's height reservation, for panes that lay it out in flow. */
export function PaneTopBanner({
  title,
  announcement,
  body,
  tone = 'warning',
  icon,
  badge,
  primaryAction,
  actionPlacement = 'end',
  progress,
  onDismiss,
  onDontShowAgain,
  onShown,
  ref,
  className
}: PaneTopBannerProps & {
  ref?: React.Ref<HTMLDivElement>
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  useEffect(() => {
    onShown?.()
  }, [onShown])
  if (tone === 'quiet') {
    return (
      <div
        ref={ref}
        role={announcement === undefined ? 'status' : undefined}
        data-tone="quiet"
        className={cn(
          // Why these insets: the text starts at the terminal's first column, and the content ends where the terminal's last
          // column does or, under floating pane controls, a gap before them.
          'relative flex h-8 items-center border-b border-border pr-[max(var(--pane-padding-x,4px),calc(var(--orca-pane-top-banner-controls-inset,0px)+0.5rem))] pl-(--pane-padding-x,4px) text-xs',
          actionPlacement === 'start' ? 'gap-1' : 'gap-2',
          className
        )}
      >
        {announcement === undefined ? null : <BannerLiveRegion announcement={announcement} />}
        <p
          className={cn(
            'min-w-0 truncate text-muted-foreground',
            actionPlacement === 'end' && 'flex-1'
          )}
        >
          {title}
        </p>
        {primaryAction}
        {progress === undefined ? null : (
          <span
            aria-hidden="true"
            className="absolute inset-x-0 -bottom-px h-0.5 origin-left bg-theme-accent opacity-70 transition-transform duration-1000 ease-linear motion-reduce:transition-none"
            style={{ transform: `scaleX(${Math.min(1, Math.max(0, progress))})` }}
          />
        )}
      </div>
    )
  }
  const Icon = icon ?? (tone === 'warning' ? TriangleAlert : null)
  const toneClasses = TONE_CLASSES[tone]

  return (
    <div
      ref={ref}
      role={announcement === undefined ? 'status' : undefined}
      // Why pr-24: an agent pane floats four controls (hand off, chat, split, close) over its top-right corner.
      className={cn(
        '@container border-b py-2 pr-24 pl-3 text-xs',
        toneClasses.stripClass,
        className
      )}
    >
      {announcement === undefined ? null : <BannerLiveRegion announcement={announcement} />}
      {/* Wrap actions in narrow panes using disjoint container-query properties so unlayered utilities cannot override them. */}
      <div className="@[44rem]:flex @[44rem]:items-center @[44rem]:gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          {Icon ? (
            // mt-px, not the 2px that centers the box: glyphs like Timer and TriangleAlert carry their
            // weight low, so they sit optically centered on the first line only a pixel higher.
            <Icon
              className={cn('mt-px size-4 shrink-0', toneClasses.iconClass)}
              aria-hidden="true"
            />
          ) : null}
          <div className="min-w-0 leading-5">
            <p className="font-medium text-foreground">
              {badge ? (
                <Badge variant="paneLabel" className="mr-1.5">
                  {badge}
                </Badge>
              ) : null}
              {title}
            </p>
            {body ? <p className="text-muted-foreground">{body}</p> : null}
          </div>
        </div>
        <div
          className={cn(
            'flex flex-wrap items-center gap-1 @[44rem]:shrink-0 @max-[44rem]:mt-1.5',
            Icon && '@max-[44rem]:pl-6.5'
          )}
        >
          {primaryAction}
          {onDontShowAgain ? (
            <Button type="button" variant="ghost" size="xs" onClick={onDontShowAgain}>
              {t('terminal.paneTopBanner.dontShowAgain', "Don't show again")}
            </Button>
          ) : null}
          {onDismiss ? (
            <Button type="button" variant="ghost" size="xs" onClick={onDismiss}>
              {t('terminal.paneTopBanner.dismiss', 'Dismiss')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
