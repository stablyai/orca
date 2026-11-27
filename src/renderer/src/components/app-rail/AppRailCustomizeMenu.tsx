import React, { Suspense, useRef, useState } from 'react'
import { Ellipsis } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useLatchedOpen } from '@/app-shell/root-surfaces/use-latched-open'
import { APP_RAIL_ICON_SIZE, APP_RAIL_ICON_STROKE_WIDTH, AppRailButton } from './AppRailButton'
import { useAppRailCustomizeLabel, type AppRailCustomizeRow } from './app-rail-menu-focus'

export type { AppRailCustomizeRow }

const LazyAppRailCustomizeMenuContent = lazyWithRetry(
  () =>
    import('./AppRailCustomizeMenuContent').then((module) => ({
      default: module.AppRailCustomizeMenuContent
    })),
  { reloadKey: 'app-rail-customize-menu-content' }
)

/** The rail's "…": which pages the rail shows, in rail order. Becomes More's Customize submenu when the rail folds. */
export function AppRailCustomizeMenu({
  rows,
  tabStop
}: {
  rows: readonly AppRailCustomizeRow[]
  tabStop: boolean
}): React.JSX.Element {
  const label = useAppRailCustomizeLabel()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const hasOpened = useLatchedOpen(open)
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <AppRailButton
              ref={triggerRef}
              itemId="customize"
              label={label}
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
          {label}
        </TooltipContent>
      </Tooltip>
      {hasOpened ? (
        <Suspense fallback={null}>
          <LazyAppRailCustomizeMenuContent open={open} rows={rows} triggerRef={triggerRef} />
        </Suspense>
      ) : null}
    </DropdownMenu>
  )
}
