import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import {
  getPreferredPublicRuntimeEndpoint,
  getRuntimeEndpointTransportKind
} from '../../../../shared/runtime-environment-endpoint-display'
import {
  getRuntimeEndpointTransportLabel,
  getRuntimeServerEndpointDisplay
} from './runtime-server-endpoint-labels'
import { translate } from '@/i18n/i18n'

export type RuntimeServerEditSaveArgs = {
  name: string
  pairingCode: string | null
}

type RuntimeServerEditDialogProps = {
  environment: PublicKnownRuntimeEnvironment | null
  open: boolean
  saving: boolean
  error: string | null
  onOpenChange: (open: boolean) => void
  onSave: (args: RuntimeServerEditSaveArgs) => void | Promise<void>
}

export function RuntimeServerEditDialog({
  environment,
  open,
  saving,
  error,
  onOpenChange,
  onSave
}: RuntimeServerEditDialogProps): React.JSX.Element {
  const [name, setName] = useState(environment?.name ?? '')
  const [pairingCode, setPairingCode] = useState('')
  const endpoint = environment ? getPreferredPublicRuntimeEndpoint(environment) : null
  const transportLabel = getRuntimeEndpointTransportLabel(getRuntimeEndpointTransportKind(endpoint))

  const trimmedName = name.trim()
  const trimmedPairingCode = pairingCode.trim()
  const nameUnchanged = environment != null && trimmedName === environment.name
  const canSave =
    trimmedName.length > 0 && (!nameUnchanged || trimmedPairingCode.length > 0) && !saving

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && saving) {
          return
        }
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="max-w-md sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.settings.RuntimeEnvironmentsPane.editServerTitle',
              'Edit Server'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.RuntimeEnvironmentsPane.editServerDescription',
              'Rename this server, or paste a new pairing code to change its connection address without removing workspaces.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="runtime-server-edit-name">
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.54ebacc600',
                'Server name'
              )}
            </Label>
            <Input
              id="runtime-server-edit-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-8 text-xs"
              autoFocus
              disabled={saving}
            />
          </div>

          <div className="space-y-1">
            <Label>
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.currentEndpoint',
                'Current connection'
              )}
            </Label>
            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
              <div className="flex min-w-0 items-center gap-2">
                {environment ? (
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                    {transportLabel}
                  </span>
                ) : null}
                <span className="min-w-0 truncate font-mono text-muted-foreground">
                  {getRuntimeServerEndpointDisplay(endpoint)}
                </span>
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="runtime-server-edit-pairing-code">
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.newPairingCode',
                'New pairing code (optional)'
              )}
            </Label>
            <Input
              id="runtime-server-edit-pairing-code"
              aria-describedby="runtime-server-edit-pairing-code-help"
              value={pairingCode}
              onChange={(event) => setPairingCode(event.target.value)}
              placeholder={translate(
                'auto.components.settings.RuntimeEnvironmentsPane.c3d772c514',
                'orca://pair?code=...'
              )}
              className="h-8 min-w-0 font-mono text-xs"
              disabled={saving}
            />
            <p id="runtime-server-edit-pairing-code-help" className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.editPairingCodeHelp',
                'Leave blank to keep the current address. To switch LAN ↔ Tailscale, generate a new pairing URL on the server with the desired --pairing-address.'
              )}
            </p>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {translate('auto.components.settings.RuntimeEnvironmentsPane.af53761f31', 'Cancel')}
          </Button>
          <Button
            type="button"
            disabled={!canSave}
            onClick={() => {
              void onSave({
                name: trimmedName,
                pairingCode: trimmedPairingCode.length > 0 ? trimmedPairingCode : null
              })
            }}
          >
            {saving ? <Loader2 className="animate-spin" /> : null}
            {translate(
              'auto.components.settings.RuntimeEnvironmentsPane.editServerSave',
              'Save Changes'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
