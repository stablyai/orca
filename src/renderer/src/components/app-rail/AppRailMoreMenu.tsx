import React, { Suspense, useLayoutEffect, useRef, useState } from 'react'
import { Ellipsis } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useLatchedOpen } from '@/app-shell/root-surfaces/use-latched-open'
import { APP_RAIL_ICON_SIZE, APP_RAIL_ICON_STROKE_WIDTH, AppRailButton } from './AppRailButton'
import { appRailSlotCapacity } from './app-rail-overflow'
import type { AppRailCustomizeRow } from './app-rail-menu-focus'
import type { AppRailMoreDestination } from './AppRailMoreMenuContent'

const LazyAppRailMoreMenuContent = lazyWithRetry(
  () =>
    import('./AppRailMoreMenuContent').then((module) => ({
      default: module.AppRailMoreMenuContent
    })),
  { reloadKey: 'app-rail-more-menu-content' }
)

/**
 * What doesn't fit on a short rail: folded pages, then Customize (the "…" this button replaced). The account button
 * never folds in here.
 */
export function AppRailMoreMenu({
  tabStop,
  destinations,
  customizeRows
}: {
  tabStop: boolean
  /** Folded destinations, in rail order: plain rows that open their page. */
  destinations: readonly AppRailMoreDestination[]
  customizeRows: readonly AppRailCustomizeRow[]
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('appRail.more', 'More')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const hasOpenedMenu = useLatchedOpen(menuOpen)
  const current = destinations.find((destination) => destination.current)?.label
  return (
    <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <AppRailButton
              ref={triggerRef}
              itemId="more"
              label={current ? `${label}, ${current}` : label}
              active={current !== undefined}
              tabStop={tabStop}
              icon={
                <Ellipsis
                  size={APP_RAIL_ICON_SIZE}
                  strokeWidth={APP_RAIL_ICON_STROKE_WIDTH}
                  aria-hidden
                />
              }
            />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={6}>
          {current ? `${label} · ${current}` : label}
        </TooltipContent>
      </Tooltip>
      {hasOpenedMenu ? (
        <Suspense fallback={null}>
          <LazyAppRailMoreMenuContent
            destinations={destinations}
            customizeRows={customizeRows}
            triggerRef={triggerRef}
          />
        </Suspense>
      ) : null}
    </DropdownMenu>
  )
}

/**
 * Whole slots that fit in the toolbar; state changes only when that number changes, not per pixel.
 * `onWillChange` runs just before a new count is committed, so callers can sample state tied to that transition.
 */
export function useAppRailSlotCapacity(
  toolbar: HTMLElement | null,
  onWillChange?: () => void
): number {
  const [capacity, setCapacity] = useState(Number.POSITIVE_INFINITY)
  const lastRef = useRef(Number.POSITIVE_INFINITY)
  const onWillChangeRef = useRef(onWillChange)
  useLayoutEffect(() => {
    onWillChangeRef.current = onWillChange
  })
  useLayoutEffect(() => {
    if (!toolbar) {
      return
    }
    let retired = false
    const measure = (): void => {
      if (retired) {
        return
      }
      // The toolbar has no border and is sized by the rail column (flex-1, min-h-0), never by its content.
      const style = getComputedStyle(toolbar)
      const padding =
        (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
      const next = appRailSlotCapacity(toolbar.getBoundingClientRect().height - padding)
      if (next === lastRef.current) {
        return
      }
      // The first measure isn't a transition: nothing was rendered under another partition yet.
      if (lastRef.current !== Number.POSITIVE_INFINITY) {
        onWillChangeRef.current?.()
      }
      lastRef.current = next
      setCapacity(next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(toolbar)
    return () => {
      retired = true
      observer.disconnect()
    }
  }, [toolbar])
  return capacity
}
