import { Loader2, RotateCcw } from 'lucide-react'
import React from 'react'
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
import { translate } from '@/i18n/i18n'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'

export function CodexResetCredits({
  resetCreditCount,
  resetCreditExpiry,
  canRedeemReset,
  isRedeemingReset,
  onReset,
  renderAction
}: {
  resetCreditCount: number
  resetCreditExpiry: string | null
  canRedeemReset: boolean
  isRedeemingReset: boolean
  onReset: () => void
  renderAction?: (action: React.ReactNode) => React.ReactNode
}): React.JSX.Element {
  const action = (
    <Button variant="outline" size="xs" disabled={isRedeemingReset} onClick={onReset}>
      {isRedeemingReset ? <Loader2 className="size-3.5 animate-spin" /> : null}
      {isRedeemingReset
        ? translate('auto.components.status.bar.StatusBar.25d8bbde69', 'Using reset…')
        : translate('auto.components.status.bar.StatusBar.e159fc1fd7', 'Reset now')}
    </Button>
  )
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0 text-2xs text-muted-foreground">
        {translate(
          'auto.components.status.bar.StatusBar.rateLimitResetsAvailable',
          '{{count}} rate-limit resets available',
          {
            count: resetCreditCount,
            defaultValue_one: '{{count}} rate-limit reset available'
          }
        )}
        {resetCreditExpiry ? <div>{resetCreditExpiry}</div> : null}
      </div>
      {canRedeemReset ? (renderAction ? renderAction(action) : action) : null}
    </div>
  )
}

export function CodexResetConfirmation({
  open,
  onOpenChange,
  skipFutureResetConfirm,
  onSkipChange,
  isRedeemingReset,
  onConfirm,
  accountLabel
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  skipFutureResetConfirm: boolean
  onSkipChange: (skip: boolean) => void
  isRedeemingReset: boolean
  onConfirm: () => void | Promise<void>
  accountLabel?: string
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]" {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}>
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.status.bar.StatusBar.972a1ff497', 'Reset Codex limits?')}
          </DialogTitle>
          <DialogDescription>
            {accountLabel
              ? translate(
                  'components.native-chat.usage.confirmReset',
                  'This uses one Codex rate-limit reset credit for {{account}} and resets any eligible usage windows immediately.',
                  { account: accountLabel }
                )
              : translate(
                  'auto.components.status.bar.StatusBar.6d1042aa6f',
                  'This uses one Codex rate-limit reset credit for the active account and resets any eligible usage windows immediately.'
                )}
          </DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-xs text-foreground/80 transition-colors hover:text-foreground">
          <Checkbox
            checked={skipFutureResetConfirm}
            onCheckedChange={(checked) => onSkipChange(checked === true)}
          />
          <span>
            {translate('auto.components.status.bar.StatusBar.f077f586db', "Don't ask again")}
          </span>
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {translate('auto.components.status.bar.StatusBar.c0e972d726', 'Cancel')}
          </Button>
          <Button onClick={() => void onConfirm()} disabled={isRedeemingReset}>
            {isRedeemingReset ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RotateCcw className="size-4" />
            )}
            {isRedeemingReset
              ? translate('auto.components.status.bar.StatusBar.25d8bbde69', 'Using reset…')
              : translate('auto.components.status.bar.StatusBar.e159fc1fd7', 'Reset now')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
