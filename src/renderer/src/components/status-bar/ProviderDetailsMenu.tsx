import React, { useRef } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { normalizeUsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import { ProviderPanel } from './tooltip'
import { ProviderLetterBadge, ProviderSegment } from './StatusBarProviderSegment'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'

export function ProviderDetailsMenu({
  provider,
  compact,
  iconOnly,
  ariaLabel,
  topContent,
  hidePanelResetCredits = false,
  open,
  onOpenChange,
  children,
  asSubmenu = false,
  triggerContent
}: {
  provider: ProviderRateLimits
  compact: boolean
  iconOnly: boolean
  ariaLabel: string
  topContent?: React.ReactNode
  hidePanelResetCredits?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children?: React.ReactNode
  // When set, render as a drill-in submenu (used by the consolidated Usage
  // popover) with triggerContent as the full-width row instead of a segment.
  asSubmenu?: boolean
  triggerContent?: React.ReactNode
}): React.JSX.Element {
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const usagePercentageDisplay = normalizeUsagePercentageDisplay(
    useAppStore((s) => s.usagePercentageDisplay)
  )
  const menuFocusHandoff = useStatusBarMenuFocusHandoff()

  const handleOpenChange = (nextOpen: boolean): void => {
    if (nextOpen) {
      menuFocusHandoff.reset()
      recordFeatureInteraction('usage-tracking')
    }
    onOpenChange?.(nextOpen)
  }

  const panelBody = (
    <>
      {topContent}
      <div className="p-2">
        {/* Why: provider-specific action sections may render richer reset-credit UI. */}
        <ProviderPanel
          p={provider}
          showResetCredits={!hidePanelResetCredits}
          usagePercentageDisplay={usagePercentageDisplay}
        />
      </div>
      {children ? (
        <>
          <DropdownMenuSeparator />
          {children}
        </>
      ) : null}
    </>
  )

  if (asSubmenu) {
    return (
      <DropdownMenuSub open={open} onOpenChange={handleOpenChange}>
        <DropdownMenuSubTrigger className="w-full items-center gap-3 px-3.5 py-2.5">
          {triggerContent}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
          collisionPadding={{ top: 8, bottom: 32, left: 8, right: 8 }}
          className="max-h-(--radix-dropdown-menu-content-available-height) w-[300px] overflow-y-auto p-0 scrollbar-sleek"
        >
          {panelBody}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    )
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70"
          aria-label={ariaLabel}
        >
          {iconOnly ? (
            <ProviderLetterBadge p={provider} />
          ) : (
            <ProviderSegment p={provider} compact={compact} display={usagePercentageDisplay} />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        side="top"
        align="start"
        sideOffset={8}
        className="w-[260px]"
        onPointerDownOutside={menuFocusHandoff.onPointerDownOutside}
        onCloseAutoFocus={menuFocusHandoff.onCloseAutoFocus}
      >
        {panelBody}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'

export function useStatusBarMenuFocusHandoff(): {
  reset: () => void
  onPointerDownOutside: () => void
  onCloseAutoFocus: (event: Event) => void
} {
  const skipCloseAutoFocusRef = useRef(false)
  return {
    reset: () => {
      skipCloseAutoFocusRef.current = false
    },
    onPointerDownOutside: () => {
      skipCloseAutoFocusRef.current = true
    },
    onCloseAutoFocus: (event) => {
      if (!skipCloseAutoFocusRef.current) {
        return
      }
      skipCloseAutoFocusRef.current = false
      // Why: Radix trigger restoration steals the first click from surfaces such as xterm.
      event.preventDefault()
    }
  }
}
