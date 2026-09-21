import { Loader2, Trash2 } from 'lucide-react'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

export function RuntimeEnvironmentSwitchDialog({
  pendingSwitchValue,
  switchingValue,
  switchError,
  getEnvironmentLabel,
  onOpenChange,
  onCancel,
  onConfirm
}: {
  pendingSwitchValue: string | null
  switchingValue: string | null
  switchError: string | null
  getEnvironmentLabel: (value: string) => string
  onOpenChange: (open: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <Dialog open={pendingSwitchValue !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.settings.RuntimeEnvironmentsPane.d570c35a99',
              'Switch Server'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.RuntimeEnvironmentsPane.b2290ed203',
              'Orca will focus this host and load its projects. Existing terminals and browser tabs on other hosts stay alive.'
            )}
          </DialogDescription>
        </DialogHeader>
        {pendingSwitchValue ? (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="text-muted-foreground">
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.05e0fc3ebf',
                'Switch to'
              )}
            </div>
            <div className="mt-0.5 truncate font-medium">
              {getEnvironmentLabel(pendingSwitchValue)}
            </div>
          </div>
        ) : null}
        {switchError ? <p className="text-sm text-destructive">{switchError}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={switchingValue !== null}>
            {translate('auto.components.settings.RuntimeEnvironmentsPane.af53761f31', 'Cancel')}
          </Button>
          <Button onClick={onConfirm} disabled={switchingValue !== null}>
            {switchingValue !== null ? <Loader2 className="animate-spin" /> : null}
            {translate('auto.components.settings.RuntimeEnvironmentsPane.d2e00809e4', 'Switch')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function RuntimeEnvironmentRemoveDialog({
  pendingRemove,
  removingId,
  removeError,
  removingActiveServer,
  onOpenChange,
  onCancel,
  onConfirm
}: {
  pendingRemove: PublicKnownRuntimeEnvironment | null
  removingId: string | null
  removeError: string | null
  removingActiveServer: boolean
  onOpenChange: (open: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <Dialog open={pendingRemove !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.settings.RuntimeEnvironmentsPane.bb90dd6487',
              'Remove Server'
            )}
          </DialogTitle>
          <DialogDescription>
            {removingActiveServer
              ? translate(
                  'auto.components.settings.RuntimeEnvironmentsPane.removeActiveServerDescription',
                  'Choose another Active Server in Advanced before removing this server. Existing host sessions are left alone.'
                )
              : translate(
                  'auto.components.settings.RuntimeEnvironmentsPane.ed3e3f069d',
                  'This removes the saved server from Orca. It does not change the active server.'
                )}
          </DialogDescription>
        </DialogHeader>
        {pendingRemove ? (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="truncate font-medium">{pendingRemove.name}</div>
            <div className="mt-0.5 truncate font-mono text-muted-foreground">
              {pendingRemove.endpoints[0]?.endpoint ??
                translate(
                  'auto.components.settings.RuntimeEnvironmentsPane.6ef71985da',
                  'No endpoint'
                )}
            </div>
          </div>
        ) : null}
        {removeError ? <p className="text-sm text-destructive">{removeError}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={removingId !== null}>
            {translate('auto.components.settings.RuntimeEnvironmentsPane.af53761f31', 'Cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={removingId !== null}>
            {removingId !== null ? <Loader2 className="animate-spin" /> : <Trash2 />}
            {translate('auto.components.settings.RuntimeEnvironmentsPane.d25f0688b1', 'Remove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
