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
import { ProviderIdentityCard } from './ProviderIdentityCard'
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
  triggerContent,
  trigger,
  identity,
  panelFooter,
  wide = false
}: {
  provider: ProviderRateLimits | null
  compact: boolean
  iconOnly: boolean
  ariaLabel: string
  topContent?: React.ReactNode
  hidePanelResetCredits?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children?: React.ReactNode
  // Drill into this provider from UsageRosterPanel using a full-width trigger row.
  asSubmenu?: boolean
  triggerContent?: React.ReactNode
  trigger?: React.ReactElement
  /** Heads the usage with the account it belongs to (see ProviderPanel). */
  identity?: React.ReactNode
  panelFooter?: React.ReactNode
  /** Room for the account list's one-line rows. */
  wide?: boolean
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
      {provider ? (
        <div className="p-2">
          {/* Why: provider-specific action sections may render richer reset-credit UI. */}
          {identity || panelFooter ? (
            <ProviderIdentityCard
              p={provider}
              identity={identity}
              footer={panelFooter}
              showResetCredits={!hidePanelResetCredits}
              usagePercentageDisplay={usagePercentageDisplay}
            />
          ) : (
            <ProviderPanel
              p={provider}
              showResetCredits={!hidePanelResetCredits}
              usagePercentageDisplay={usagePercentageDisplay}
            />
          )}
        </div>
      ) : null}
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
          className={wide ? 'w-[400px] max-w-[calc(100vw-1rem)]' : 'w-[300px]'}
        >
          {/* Why: the primitive owns its padding and clips overflow, so the scroller sits inside it. */}
          <div className="-m-1 max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto p-1 scrollbar-sleek">
            {panelBody}
          </div>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    )
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            className="inline-flex items-center cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70"
            aria-label={ariaLabel}
          >
            {!provider ? null : iconOnly ? (
              <ProviderLetterBadge p={provider} />
            ) : (
              <ProviderSegment p={provider} compact={compact} display={usagePercentageDisplay} />
            )}
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        side="top"
        align="start"
        sideOffset={8}
        className={wide ? 'w-[400px] max-w-[calc(100vw-1rem)]' : 'w-[260px]'}
        onPointerDownOutside={menuFocusHandoff.onPointerDownOutside}
        onCloseAutoFocus={menuFocusHandoff.onCloseAutoFocus}
      >
        {panelBody}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

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
