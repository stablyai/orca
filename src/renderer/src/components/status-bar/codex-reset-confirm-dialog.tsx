import React from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
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

export function renderCodexResetConfirmDialog({
  open,
  setOpen,
  skipFutureResetConfirm,
  setSkipFutureResetConfirm,
  isRedeemingReset,
  handleConfirmReset
}: {
  open: boolean
  setOpen: (open: boolean) => void
  skipFutureResetConfirm: boolean
  setSkipFutureResetConfirm: (skip: boolean) => void
  isRedeemingReset: boolean
  handleConfirmReset: () => Promise<void>
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        // Why: the reset item calls preventDefault() in onSelect to keep the
        // dropdown open, so this confirm opens under a live z-70 menu. The
        // default dialog z-50 would let the menu cover it.
        overlayClassName="z-[110]"
        className="z-[120] sm:max-w-[420px]"
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
      >
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.status.bar.StatusBar.972a1ff497', 'Reset Codex limits?')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.status.bar.StatusBar.6d1042aa6f',
              'This uses one Codex rate-limit reset credit for the active account and resets any eligible usage windows immediately.'
            )}
          </DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-xs text-foreground/80 transition-colors hover:text-foreground">
          <Checkbox
            checked={skipFutureResetConfirm}
            onCheckedChange={(checked) => setSkipFutureResetConfirm(checked === true)}
          />
          <span>
            {translate('auto.components.status.bar.StatusBar.f077f586db', "Don't ask again")}
          </span>
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {translate('auto.components.status.bar.StatusBar.c0e972d726', 'Cancel')}
          </Button>
          <Button onClick={() => void handleConfirmReset()} disabled={isRedeemingReset}>
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
