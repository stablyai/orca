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
import { useAppStore } from '../../../store'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { normalizeUsagePercentageDisplay } from '../../../../../shared/agent-usage/display/usage-percentage-display'
import { ProviderPanel } from './provider-usage-panel'
import { ProviderIdentityCard } from '../accounts/ProviderIdentityCard'
import { UsageDisplayToggle } from './usage-meter'
import { ProviderLetterBadge, ProviderSegment } from './StatusBarProviderSegment'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from '../composition/status-bar-context-menu-policy'

export function ProviderDetailsMenu({
  provider,
  iconOnly = false,
  ariaLabel,
  topContent,
  open,
  onOpenChange,
  children,
  asSubmenu = false,
  triggerContent,
  trigger,
  accountLabel,
  bannerContent,
  panelFooter,
  variant = 'default'
}: {
  provider: ProviderRateLimits | null
  iconOnly?: boolean
  ariaLabel: string
  topContent?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children?: React.ReactNode
  // Drill into this provider from UsageRosterPanel using a full-width trigger row.
  asSubmenu?: boolean
  triggerContent?: React.ReactNode
  trigger?: React.ReactElement
  accountLabel?: string
  /** Account variant only: rendered under the provider header, above the usage card. */
  bannerContent?: React.ReactNode
  panelFooter?: React.ReactNode
  variant?: 'default' | 'account'
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
          {variant === 'account' ? (
            <ProviderIdentityCard
              p={provider}
              accountLabel={accountLabel}
              banner={bannerContent}
              footer={panelFooter}
              usagePercentageDisplay={usagePercentageDisplay}
              inMenu
            />
          ) : (
            <ProviderPanel
              p={provider}
              usagePercentageDisplay={usagePercentageDisplay}
              headerAction={<UsageDisplayToggle asMenuItem />}
            />
          )}
        </div>
      ) : null}
      {children ? (
        <>
          {/* Why: the account card is already bordered, so a rule under it is redundant. */}
          {variant === 'account' && provider ? null : <DropdownMenuSeparator />}
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
          scrollable
          className="w-[440px] max-w-[calc(100vw-1rem)]"
        >
          {panelBody}
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
              <ProviderSegment p={provider} display={usagePercentageDisplay} />
            )}
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        side="top"
        align="start"
        sideOffset={8}
        className="w-[440px] max-w-[calc(100vw-1rem)]"
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
