import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { BarChart3, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { shouldShowUsagePercentageDisplayChangeNotice } from '../../../../shared/usage-percentage-display-change-notice'
import { USAGE_PERCENTAGE_DISPLAY_SETTING_ID } from '../settings/appearance-usage-percentage-search'

// Why: let startup modals settle before the status-bar callout competes for focus.
const SHOW_DELAY_MS = 1_800
// Why: gap between the top of the status-bar meters and the bottom of the card.
const ANCHOR_GAP_PX = 10
const CARD_WIDTH_PX = 320

type AnchorPosition = {
  bottom: number
  left: number
}

function openUsagePercentageSettings(): void {
  const store = useAppStore.getState()
  // Why: openSettingsPage wipes any leftover search; do not re-apply a search
  // filter — deep-link to the stable row id and let Appearance expand Window.
  store.openSettingsPage()
  store.openSettingsTarget({
    pane: 'appearance',
    repoId: null,
    sectionId: USAGE_PERCENTAGE_DISPLAY_SETTING_ID
  })
}

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

/**
 * One-time elevated callout anchored above the status-bar usage meters after
 * the default flipped from remaining → used. Permanent dismiss only.
 *
 * Why fixed + portal: status-bar ancestors use overflow-hidden flex shells, so
 * in-tree absolute positioning clips or attaches to the wrong containing block.
 */
export function UsagePercentageDisplayChangeNotice({
  children,
  hasVisibleUsageMeters
}: {
  children: ReactNode
  // Why: StatusBar owns which meter children actually render (status-bar items,
  // CLI detection, MiniMax/Grok durability). Don't re-derive empty-state here.
  hasVisibleUsageMeters: boolean
}): React.JSX.Element {
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const dismissed = useAppStore((s) => s.usagePercentageDisplayChangeNoticeDismissed)
  const dismiss = useAppStore((s) => s.dismissUsagePercentageDisplayChangeNotice)
  const statusBarVisible = useAppStore((s) => s.statusBarVisible)
  const activeModal = useAppStore((s) => s.activeModal)
  const [delayElapsed, setDelayElapsed] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const [anchorPosition, setAnchorPosition] = useState<AnchorPosition | null>(null)

  const eligible = shouldShowUsagePercentageDisplayChangeNotice({
    persistedUIReady,
    usagePercentageDisplayChangeNoticeDismissed: dismissed,
    statusBarVisible,
    hasVisibleUsageMeters,
    activeModal
  })

  useEffect(() => {
    if (!eligible) {
      setDelayElapsed(false)
      return
    }
    const timer = window.setTimeout(() => {
      setDelayElapsed(true)
    }, SHOW_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [eligible])

  const open = eligible && delayElapsed

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

  const openSettings = (): void => {
    dismiss()
    openUsagePercentageSettings()
  }

  const card =
    open && anchorPosition
      ? createPortal(
          <div
            role="status"
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
                  <div className="text-sm font-semibold leading-snug">
                    {translate(
                      'auto.components.status.bar.UsagePercentageDisplayChangeNotice.title',
                      'Usage now shows % used'
                    )}
                  </div>
                </div>
                <p className="text-sm leading-5 text-muted-foreground">
                  {translate(
                    'auto.components.status.bar.UsagePercentageDisplayChangeNotice.body',
                    'Prefer remaining? Change it in Settings.'
                  )}
                </p>
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
            <div className="mt-3 flex gap-2">
              <Button variant="default" size="sm" className="min-w-0 flex-1" onClick={openSettings}>
                {translate(
                  'auto.components.status.bar.UsagePercentageDisplayChangeNotice.openSettings',
                  'Open Settings'
                )}
              </Button>
              <Button variant="secondary" size="sm" className="w-[84px]" onClick={dismiss}>
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
