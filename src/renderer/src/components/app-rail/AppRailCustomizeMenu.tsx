import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
    const top = anchorRef.current?.getBoundingClientRect().top
    if (openedTopRef.current !== null && top !== undefined) {
      setAlignOffset(openedTopRef.current - top)
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
  /** `byPointer`: toggled with the mouse (or pen/touch) rather than the keyboard. */
  onToggle: (byPointer: boolean) => void
}

export function useAppRailCustomizeLabel(): string {
  const t = useTranslate()
  return t('appRail.customize', 'Customize')
}

/**
 * One checkbox row per rail page; toggling keeps the menu open so several can change in one visit. `focusRow` is the
 * row a toggle left focused before "…" and More swapped; the checklist reopened in the new form starts on it.
 */
export function AppRailCustomizeRows({
  rows,
  focusRow = null
}: {
  rows: readonly AppRailCustomizeRow[]
  focusRow?: string | null
}): React.JSX.Element {
  // Focus the row as it attaches, so it already holds focus when the menu's opening focus scope looks. Once only: the
  // row's composed ref is rebuilt on its re-renders, and focus must not follow the arrow keys back to it.
  const pendingFocusRef = useRef(focusRow)
  const focusPendingRow = useCallback((node: HTMLDivElement | null) => {
    if (node && pendingFocusRef.current !== null) {
      pendingFocusRef.current = null
      node.focus({ preventScroll: true })
    }
  }, [])
  // Whether the toggle came from the pointer: Radix selects on the click that follows a pointerdown or a Space/Enter.
  const byPointerRef = useRef(false)
  return (
    <>
      {rows.map((row) => (
        <DropdownMenuItem
          key={row.id}
          ref={row.id === focusRow ? focusPendingRow : undefined}
          role="menuitemcheckbox"
          aria-checked={row.shown}
          onPointerDown={() => {
            byPointerRef.current = true
          }}
          // A press that started elsewhere (on "…") and is released on a row selects it on pointerup alone.
          onPointerUp={() => {
            byPointerRef.current = true
          }}
          onKeyDown={() => {
            byPointerRef.current = false
          }}
          onSelect={(event) => {
            event.preventDefault()
            row.onToggle(byPointerRef.current)
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

/**
 * A checklist toggle that swaps "…" and More remounts the "…" slot as the other form. The rail hands the new form the
 * row that was toggled (`reopenOn`, read at mount only) so it opens its checklist on that row, and hears when the
 * checklist closes (`onChecklistClose`) so a later swap doesn't reopen it.
 */
export type AppRailChecklistCarry = {
  reopenOn: string | null
  /** The toggle was a pointer click, so the pointer rests where the old checklist was. */
  reopenedUnderPointer: boolean
  /** Stable. Called once the new form has taken the row, and when its checklist closes. */
  release: () => void
}

/** The new form takes the carried row once, at mount; releasing it keeps any later mount from reopening on it. */
export function useTakeChecklistCarry(checklist: AppRailChecklistCarry): string | null {
  const [taken] = useState(checklist.reopenOn)
  const { release } = checklist
  useEffect(() => {
    if (taken !== null) {
      release()
    }
  }, [taken, release])
  return taken
}

/** The rail's "…": which pages the rail shows, in rail order. Becomes More's Customize submenu when the rail folds. */
export function AppRailCustomizeMenu({
  rows,
  tabStop,
  checklist
}: {
  rows: readonly AppRailCustomizeRow[]
  tabStop: boolean
  checklist: AppRailChecklistCarry
}): React.JSX.Element {
  const label = useAppRailCustomizeLabel()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const reopenOn = useTakeChecklistCarry(checklist)
  const [open, setOpen] = useState(reopenOn !== null)
  // Only the opening this form mounted with starts on the carried row; later openings start as usual.
  const [focusRow, setFocusRow] = useState(reopenOn)
  const heldInPlace = useMenuHeldInPlace(open, triggerRef, rows)
  const handleOpenChange = (next: boolean): void => {
    setOpen(next)
    if (!next) {
      setFocusRow(null)
      checklist.release()
    }
  }
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={handleOpenChange}>
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
        <AppRailCustomizeRows rows={rows} focusRow={focusRow} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
