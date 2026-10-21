import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { BarChart3, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

const SHOW_DELAY_MS = 1_800
const ANCHOR_GAP_PX = 10
const CARD_WIDTH_PX = 320

type AnchorPosition = { bottom: number; left: number }

function measureAnchorPosition(anchor: HTMLElement): AnchorPosition {
  const rect = anchor.getBoundingClientRect()
  const maxLeft = Math.max(8, window.innerWidth - CARD_WIDTH_PX - 8)
  return {
    // Why: fixed + bottom keeps the card glued above the meters as the window
    // resizes; CSS bottom is distance from the viewport bottom edge.
    bottom: Math.max(8, window.innerHeight - rect.top + ANCHOR_GAP_PX),
    left: Math.min(Math.max(8, rect.left), maxLeft)
  }
}

/** Portals above the usage meters without taking focus or obscuring their menus. */
export function StatusBarUsageChangeNoticeCard({
  children,
  noticeKey,
  eligible,
  dismiss,
  title,
  description,
  action
}: {
  children: ReactNode
  noticeKey: string
  eligible: boolean
  dismiss: () => void
  title: string
  description: ReactNode
  action?: { label: string; onClick: () => void }
}): React.JSX.Element {
  const [elapsedNoticeKey, setElapsedNoticeKey] = useState<string | null>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const [anchorPosition, setAnchorPosition] = useState<AnchorPosition | null>(null)

  useEffect(() => {
    setElapsedNoticeKey(null)
    if (!eligible) {
      return
    }
    const timer = window.setTimeout(() => {
      setElapsedNoticeKey(noticeKey)
    }, SHOW_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [eligible, noticeKey])

  const open = eligible && elapsedNoticeKey === noticeKey

  useLayoutEffect(() => {
    if (!open) {
      setAnchorPosition(null)
      return
    }
    const anchor = anchorRef.current
    if (!anchor) {
      return
    }

    const update = (): void => {
      const next = measureAnchorPosition(anchor)
      // Why: ResizeObserver/resize fire on every reflow, but measureAnchorPosition
      // returns a fresh object each time; bail on unchanged geometry so equal
      // deliveries don't churn re-renders (avoids feeding a layout-effect loop).
      setAnchorPosition((prev) =>
        prev && prev.bottom === next.bottom && prev.left === next.left ? prev : next
      )
    }
    update()

    // Why: meters reflow when the status bar goes compact/icon-only or the
    // window resizes; keep the fixed card locked to the live anchor box.
    const observer = new ResizeObserver(update)
    observer.observe(anchor)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        dismiss()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [dismiss, open])

  const card =
    open && anchorPosition
      ? createPortal(
          <div
            role="status"
            aria-label={title}
            // Why: dropdowns/context menus use z-[70]; this callout must sit
            // under them so status-bar provider menus stay clickable.
            className="status-bar-change-notice-card fixed z-[50] w-[320px] max-w-[calc(100vw-16px)] rounded-lg p-3.5"
            style={{
              bottom: anchorPosition.bottom,
              left: anchorPosition.left
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1.5">
                <div className="flex items-center gap-2">
                  <span
                    className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-foreground"
                    aria-hidden="true"
                  >
                    <BarChart3 className="size-3.5" />
                  </span>
                  <div className="text-sm font-semibold leading-snug">{title}</div>
                </div>
                <p className="text-sm leading-5 text-muted-foreground">{description}</p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                onClick={dismiss}
                aria-label={translate(
                  'auto.components.status.bar.UsagePercentageDisplayChangeNotice.dismiss',
                  'Dismiss'
                )}
              >
                <X className="size-3.5" />
              </Button>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              {action ? (
                <Button
                  variant="default"
                  size="sm"
                  className="min-w-0 flex-1"
                  onClick={action.onClick}
                >
                  {action.label}
                </Button>
              ) : null}
              <Button variant={action ? 'secondary' : 'default'} size="sm" onClick={dismiss}>
                {translate(
                  'auto.components.status.bar.UsagePercentageDisplayChangeNotice.gotIt',
                  'Got it'
                )}
              </Button>
            </div>
          </div>,
          document.body
        )
      : null

  return (
    <>
      <div ref={anchorRef} className="flex items-center gap-3">
        {children}
      </div>
      {card}
    </>
  )
}
