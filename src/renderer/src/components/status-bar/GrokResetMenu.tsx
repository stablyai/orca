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
    !hasActiveRuntimeEnvironment && resetCreditCount !== null && resetCreditCount > 0

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
      await consumeReset()
    } catch (error) {
      console.error('Failed to redeem Grok usage-limit reset from status bar:', error)
      toast.error(
        translate(
          'auto.components.status.bar.GrokResetMenu.1d0a238e8b',
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
        'auto.components.status.bar.GrokResetMenu.5083fdb684',
        'Open Grok details and usage-limit reset'
      )}
      open={open}
      onOpenChange={setOpen}
    >
      <Dialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <DialogContent className="sm:max-w-[420px]" {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}>
          <DialogHeader>
            <DialogTitle>
              {translate(
                'auto.components.status.bar.GrokResetMenu.febaa254bf',
                'Reset Grok limits?'
              )}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.status.bar.GrokResetMenu.2fd82006e3',
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
              {translate('auto.components.status.bar.GrokResetMenu.3fc8633cbf', "Don't ask again")}
            </span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetConfirmOpen(false)}>
              {translate('auto.components.status.bar.GrokResetMenu.d2801b1ae1', 'Cancel')}
            </Button>
            <Button onClick={() => void confirmReset()} disabled={isRedeemingReset}>
              {isRedeemingReset ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCcw className="size-4" />
              )}
              {isRedeemingReset
                ? translate('auto.components.status.bar.GrokResetMenu.de40a51f9b', 'Using reset…')
                : translate('auto.components.status.bar.GrokResetMenu.3ca4f108f6', 'Reset now')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {resetCreditCount !== null ? (
        <>
          <DropdownMenuLabel className="space-y-0.5">
            <div>
              {resetCreditCount === 1
                ? translate(
                    'auto.components.status.bar.GrokResetMenu.5b42bad652',
                    '1 rate-limit reset available'
                  )
                : translate(
                    'auto.components.status.bar.GrokResetMenu.d101726b6a',
                    '{{value0}} rate-limit resets available',
                    { value0: resetCreditCount }
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
                ? translate('auto.components.status.bar.GrokResetMenu.de40a51f9b', 'Using reset…')
                : translate('auto.components.status.bar.GrokResetMenu.3ca4f108f6', 'Reset now')}
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
        {translate('auto.components.status.bar.GrokResetMenu.58b2e3f032', 'Manage Accounts…')}
      </DropdownMenuItem>
    </ProviderDetailsMenu>
  )
}
