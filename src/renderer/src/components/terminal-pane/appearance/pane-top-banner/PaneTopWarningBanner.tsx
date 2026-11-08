import { useEffect, useLayoutEffect, useRef } from 'react'
import { TriangleAlert, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
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

/** Reserves the banner's height at the top of its pane so the terminal refits below it. */
function useReservePaneTopSpace(): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const banner = ref.current
    const pane = banner?.parentElement
    if (!banner || !pane) {
      return
    }
    // Why the whole pane: two banners can share it, so each one's height moves the ones below.
    const reserve = (): void => layoutPaneTopBanners(pane)
    reserve()
    const observer = new ResizeObserver(reserve)
    observer.observe(banner)
    return () => {
      observer.disconnect()
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

type PaneTopBannerTone = 'warning' | 'neutral' | 'accent'

const TONE_CLASSES: Record<PaneTopBannerTone, { stripClass: string; iconClass: string }> = {
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

/** The strip across the top of a terminal pane, with its actions and optional Dismiss; neutral is plain state, without the warning icon. */
export function PaneTopWarningBanner({
  title,
  body,
  tone = 'warning',
  icon,
  badge,
  primaryAction,
  onDismiss,
  onDontShowAgain,
  onShown
}: {
  title: string
  body?: React.ReactNode
  tone?: PaneTopBannerTone
  /** Replaces the warning icon; neutral and accent show none without it. */
  icon?: LucideIcon
  /** A short label set before the title, e.g. what kind of pane this is. */
  badge?: string
  primaryAction: React.ReactNode
  onDismiss?: () => void
  onDontShowAgain?: () => void
  onShown?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const ref = useReservePaneTopSpace()
  useEffect(() => {
    onShown?.()
  }, [onShown])
  const Icon = icon ?? (tone === 'warning' ? TriangleAlert : null)
  const toneClasses = TONE_CLASSES[tone]

  return (
    <div
      ref={ref}
      role="status"
      // Why pr-24: an agent pane floats four controls (hand off, chat, split, close) over its top-right corner.
      className={cn(
        'pane-top-banner @container border-b py-2 pr-24 pl-3 text-xs',
        toneClasses.stripClass
      )}
    >
      {/* Wrap actions in narrow panes using disjoint container-query properties so unlayered utilities cannot override them. */}
      <div className="@[44rem]:flex @[44rem]:items-center @[44rem]:gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          {Icon ? (
            <Icon
              className={cn('mt-0.5 size-4 shrink-0', toneClasses.iconClass)}
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
