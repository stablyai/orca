import React, { useLayoutEffect, useRef, useState } from 'react'
import { Check, Ellipsis } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { APP_RAIL_ICON_SIZE, APP_RAIL_ICON_STROKE_WIDTH, AppRailButton } from './AppRailButton'

/**
 * Keep an open menu where it opened while its anchor moves (a toggle adds or removes a slot above "…", or a row above
 * More's Customize), so the next click lands on the row it aims at. Reopening anchors afresh. `moveKey` changes on
 * every render that can move the anchor.
 */
export function useMenuHeldInPlace(
  open: boolean,
  anchorRef: React.RefObject<HTMLElement | null>,
  moveKey: unknown
): { alignOffset: number; sticky: 'always' } {
  const openedTopRef = useRef<number | null>(null)
  const [alignOffset, setAlignOffset] = useState(0)
  useLayoutEffect(() => {
    openedTopRef.current = open ? (anchorRef.current?.getBoundingClientRect().top ?? null) : null
    setAlignOffset(0)
  }, [open, anchorRef])
  useLayoutEffect(() => {
    const openedTop = openedTopRef.current
    if (openedTop === null) {
      return
    }
    const top = anchorRef.current?.getBoundingClientRect().top
    if (top !== undefined) {
      setAlignOffset(openedTop - top)
    }
  }, [moveKey, anchorRef])
  // Radix's default "partial" stickiness would pull the menu back to touch the moved anchor.
  return { alignOffset, sticky: 'always' }
}

/**
 * Radix leaves focus where an outside click put it, which is the body when the click lands on blank space; hand it back
 * to the menu's trigger then. Checked a frame later, after the dismissing click's own focus change.
 */
export function refocusTriggerIfFocusLost(trigger: HTMLElement | null): void {
  requestAnimationFrame(() => {
    const active = document.activeElement
    if ((!active || active === document.body || !active.isConnected) && trigger?.isConnected) {
      trigger.focus({ preventScroll: true })
    }
  })
}

export type AppRailCustomizeRow = {
  id: string
  label: string
  icon: React.ReactNode
  shown: boolean
  onToggle: () => void
}

export function useAppRailCustomizeLabel(): string {
  const t = useTranslate()
  return t('appRail.customize', 'Customize')
}

/** One checkbox row per rail page; toggling keeps the menu open so several can change in one visit. */
export function AppRailCustomizeRows({
  rows
}: {
  rows: readonly AppRailCustomizeRow[]
}): React.JSX.Element {
  return (
    <>
      {rows.map((row) => (
        <DropdownMenuItem
          key={row.id}
          role="menuitemcheckbox"
          aria-checked={row.shown}
          onSelect={(event) => {
            event.preventDefault()
            row.onToggle()
          }}
        >
          {row.icon}
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
          <Check
            className={cn('size-3.5 text-muted-foreground', !row.shown && 'invisible')}
            aria-hidden
          />
        </DropdownMenuItem>
      ))}
    </>
  )
}

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
  const heldInPlace = useMenuHeldInPlace(open, triggerRef, rows)
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
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={8}
        {...heldInPlace}
        onCloseAutoFocus={() => refocusTriggerIfFocusLost(triggerRef.current)}
      >
        <AppRailCustomizeRows rows={rows} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
