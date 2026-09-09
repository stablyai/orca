import { Loader2, RotateCcw } from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { useAppStore } from '../../store'
import { ProviderDetailsMenu } from './ProviderDetailsMenu'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import { formatResetCreditExpiry } from './tooltip'

export function GrokResetMenu({
  grok,
  compact,
  iconOnly,
  asSubmenu = false,
  triggerContent
}: {
  grok: ProviderRateLimits
  compact: boolean
  iconOnly: boolean
  asSubmenu?: boolean
  triggerContent?: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [skipFutureResetConfirm, setSkipFutureResetConfirm] = useState(false)
  const [isRedeemingReset, setIsRedeemingReset] = useState(false)
  const mountedRef = useRef(true)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const consumeReset = useAppStore((state) => state.consumeGrokRateLimitResetCredit)
  const settings = useAppStore((state) => state.settings)
  const hasActiveRuntimeEnvironment = Boolean(settings?.activeRuntimeEnvironmentId?.trim())
  const resetCreditCount = grok.rateLimitResetCredits?.availableCount ?? null
  const resetCreditExpiry =
    resetCreditCount !== null
      ? formatResetCreditExpiry(grok.rateLimitResetCredits?.nextExpiresAt, resetCreditCount)
      : null
  // Why: desktop redemption uses this machine's Grok CLI login, not a remote host's.
  const canRedeemReset =
    !hasActiveRuntimeEnvironment &&
    resetCreditCount !== null &&
    resetCreditCount > 0 &&
    typeof grok.weekly?.usedPercent === 'number' &&
    grok.weekly.usedPercent > 0

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const redeemReset = async (): Promise<void> => {
    if (isRedeemingReset) {
      return
    }
    setIsRedeemingReset(true)
    try {
      const outcome = await consumeReset()
      if (outcome === 'usageUnavailable') {
        toast.error(
          translate(
            'components.grokResetMenu.usageUnavailable',
            'Could not verify Grok usage. Try again.'
          )
        )
      }
    } catch (error) {
      console.error('Failed to redeem Grok usage-limit reset from status bar:', error)
      toast.error(
        translate(
          'components.grokResetMenu.failure',
          'Could not use the SuperGrok reset. Try again.'
        )
      )
    } finally {
      if (mountedRef.current) {
        setIsRedeemingReset(false)
      }
    }
  }

  const selectReset = (): void => {
    if (settings?.skipGrokRateLimitResetConfirm) {
      void redeemReset()
      return
    }
    setSkipFutureResetConfirm(false)
    setResetConfirmOpen(true)
  }

  const confirmReset = async (): Promise<void> => {
    if (isRedeemingReset) {
      return
    }
    if (skipFutureResetConfirm) {
      try {
        await updateSettings({ skipGrokRateLimitResetConfirm: true })
      } catch (error) {
        console.error('Failed to save Grok reset confirmation preference:', error)
      }
    }
    await redeemReset()
    if (mountedRef.current) {
      setResetConfirmOpen(false)
      setSkipFutureResetConfirm(false)
    }
  }

  return (
    <ProviderDetailsMenu
      provider={grok}
      compact={compact}
      iconOnly={iconOnly}
      asSubmenu={asSubmenu}
      triggerContent={triggerContent}
      hidePanelResetCredits
      ariaLabel={translate(
        'components.grokResetMenu.openDetails',
        'Open Grok details and usage-limit reset'
      )}
      open={open}
      onOpenChange={setOpen}
    >
      <Dialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <DialogContent className="sm:max-w-[420px]" {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}>
          <DialogHeader>
            <DialogTitle>
              {translate('components.grokResetMenu.confirmTitle', 'Reset Grok limits?')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'components.grokResetMenu.confirmDescription',
                'This uses one SuperGrok usage-limit reset token for the signed-in account and clears the current weekly pool immediately.'
              )}
            </DialogDescription>
          </DialogHeader>
          <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-xs text-foreground/80 transition-colors hover:text-foreground">
            <Checkbox
              checked={skipFutureResetConfirm}
              onCheckedChange={(checked) => setSkipFutureResetConfirm(checked === true)}
            />
            <span>
              {translate('components.grokResetMenu.skipFutureConfirmation', "Don't ask again")}
            </span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetConfirmOpen(false)}>
              {translate('components.grokResetMenu.cancel', 'Cancel')}
            </Button>
            <Button onClick={() => void confirmReset()} disabled={isRedeemingReset}>
              {isRedeemingReset ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCcw className="size-4" />
              )}
              {isRedeemingReset
                ? translate('components.grokResetMenu.redeeming', 'Using reset…')
                : translate('components.grokResetMenu.redeemNow', 'Reset now')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {resetCreditCount !== null ? (
        <>
          <DropdownMenuLabel className="space-y-0.5">
            <div>
              {resetCreditCount === 1
                ? translate('components.grokResetMenu.availableOne', '1 rate-limit reset available')
                : translate(
                    'components.grokResetMenu.availableMany',
                    '{{count}} rate-limit resets available',
                    { count: resetCreditCount }
                  )}
            </div>
            {resetCreditExpiry ? (
              <div className="text-[11px] font-normal text-muted-foreground">
                {resetCreditExpiry}
              </div>
            ) : null}
          </DropdownMenuLabel>
          {resetCreditCount > 0 ? (
            <DropdownMenuItem
              disabled={!canRedeemReset || isRedeemingReset}
              onSelect={(event) => {
                event.preventDefault()
                if (canRedeemReset) {
                  selectReset()
                }
              }}
            >
              {isRedeemingReset ? (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              ) : null}
              {isRedeemingReset
                ? translate('components.grokResetMenu.redeeming', 'Using reset…')
                : translate('components.grokResetMenu.redeemNow', 'Reset now')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
        </>
      ) : null}
      <DropdownMenuItem
        onSelect={() => {
          openSettingsTarget({ pane: 'accounts', repoId: null, sectionId: 'accounts-grok' })
          openSettingsPage()
        }}
      >
        {translate('components.grokResetMenu.manageAccounts', 'Manage Accounts…')}
      </DropdownMenuItem>
    </ProviderDetailsMenu>
  )
}
