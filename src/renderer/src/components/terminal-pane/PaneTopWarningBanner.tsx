import { useEffect, useLayoutEffect, useRef } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

/** Reserves the banner's height at the top of its pane so the terminal refits below it. */
function useReservePaneTopSpace(): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const banner = ref.current
    const pane = banner?.parentElement
    if (!banner || !pane) {
      return
    }
    const reserve = (): void => {
      pane.style.setProperty('--orca-pane-top-banner-height', `${banner.offsetHeight}px`)
    }
    reserve()
    const observer = new ResizeObserver(reserve)
    observer.observe(banner)
    return () => {
      observer.disconnect()
      pane.style.removeProperty('--orca-pane-top-banner-height')
    }
  }, [])
  return ref
}

export function PaneBannerLearnMore({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className="text-foreground underline underline-offset-2 hover:text-foreground/80"
      onClick={onClick}
    >
      {translate('terminal.paneTopBanner.learnMore', 'Learn more')}
    </button>
  )
}

/** The warning strip across the top of a terminal pane, with its actions and Dismiss. */
export function PaneTopWarningBanner({
  title,
  body,
  primaryAction,
  onDismiss,
  onDontShowAgain,
  onShown
}: {
  title: string
  body: React.ReactNode
  primaryAction: React.ReactNode
  onDismiss: () => void
  onDontShowAgain?: () => void
  onShown?: () => void
}): React.JSX.Element {
  const ref = useReservePaneTopSpace()
  useEffect(() => {
    onShown?.()
  }, [onShown])

  return (
    <div
      ref={ref}
      role="status"
      // Why pr-16: the pane's own split/close controls float over its top-right corner.
      className="pane-top-banner @container border-b border-status-warning-border bg-status-warning-background py-2 pr-16 pl-3 text-xs"
    >
      {/* Why a container query: split panes are narrow, so actions drop below the text there.
          Narrow and wide variants never share a property, so an unlayered utility cannot override them. */}
      <div className="@[44rem]:flex @[44rem]:items-center @[44rem]:gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <TriangleAlert
            className="mt-0.5 size-4 shrink-0 text-status-warning"
            aria-hidden="true"
          />
          <div className="min-w-0 leading-5">
            <p className="font-medium text-foreground">{title}</p>
            <p className="text-muted-foreground">{body}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 @[44rem]:shrink-0 @max-[44rem]:mt-1.5 @max-[44rem]:pl-6.5">
          {primaryAction}
          {onDontShowAgain ? (
            <Button type="button" variant="ghost" size="xs" onClick={onDontShowAgain}>
              {translate('terminal.paneTopBanner.dontShowAgain', "Don't show again")}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="xs" onClick={onDismiss}>
            {translate('terminal.paneTopBanner.dismiss', 'Dismiss')}
          </Button>
        </div>
      </div>
    </div>
  )
}
