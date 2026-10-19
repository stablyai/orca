import { Loader2, Link2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { parseHostAccessLink } from '../../../../shared/remote-pairing-address'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { translateHostAccessLinkError } from '@/lib/remote-pairing-copy'
import { refreshRuntimeEnvironmentCatalog } from '@/runtime/runtime-environment-pairing-refresh'
import { clearRuntimeCompatibilityCache } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import {
  RuntimeHostAccessFailureAlert,
  type RuntimeHostAccessFailure
} from './RuntimeHostAccessFailureAlert'

type RuntimeRepairDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  environmentId: string
  name: string
}

/** Pastes a fresh pairing link into a saved server whose pairing it revoked. */
export function RuntimeRepairDialog({
  open,
  onOpenChange,
  environmentId,
  name
}: RuntimeRepairDialogProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        {/* Why inside the content: it unmounts on close, so a reopen starts from an empty link. */}
        <RuntimeRepairForm
          environmentId={environmentId}
          name={name}
          busy={busy}
          setBusy={setBusy}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

function RuntimeRepairForm({
  environmentId,
  name,
  busy,
  setBusy,
  onClose
}: {
  environmentId: string
  name: string
  busy: boolean
  setBusy: (busy: boolean) => void
  onClose: () => void
}): React.JSX.Element {
  const [accessLink, setAccessLink] = useState('')
  const [failure, setFailure] = useState<RuntimeHostAccessFailure | null>(null)
  const mountedRef = useMountedRef()
  const parsed = useMemo(() => parseHostAccessLink(accessLink), [accessLink])
  const inputError = accessLink.trim() !== '' && !parsed.ok

  const submit = async (): Promise<void> => {
    if (!parsed.ok || busy) {
      return
    }
    setBusy(true)
    setFailure(null)
    try {
      const result = await window.api.runtimeEnvironments.repairFromPairingCode({
        selector: environmentId,
        pairingCode: accessLink.trim()
      })
      if (!result.ok) {
        if (mountedRef.current) {
          setFailure({ kind: result.kind, message: result.message })
        }
        return
      }
      clearRuntimeCompatibilityCache(environmentId)
      await refreshRuntimeEnvironmentCatalog()
      await useAppStore.getState().readRuntimeHostStatusSnapshots()
      toast.success(
        translate(
          'auto.components.settings.RuntimeRepairDialog.success',
          'Re-paired with {{name}}',
          {
            name
          }
        )
      )
      if (mountedRef.current) {
        onClose()
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('auto.components.settings.RuntimeRepairDialog.failed', 'Re-pair failed')
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {translate('auto.components.settings.RuntimeRepairDialog.title', 'Re-pair {{name}}', {
            name
          })}
        </DialogTitle>
        <DialogDescription>
          {translate(
            'auto.components.settings.RuntimeRepairDialog.description',
            '{{name}} no longer accepts this computer. On {{name}}, open Settings → Remote Orca Servers → Share this host, create a link for another Orca client, then paste it here.',
            { name }
          )}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="runtime-repair-access-link">
          {translate('auto.components.settings.RuntimeHostAccessForm.accessLink', 'Access link')}
        </Label>
        <Input
          id="runtime-repair-access-link"
          autoFocus
          value={accessLink}
          disabled={busy}
          aria-invalid={inputError || failure !== null}
          aria-describedby={
            failure
              ? 'runtime-repair-error'
              : inputError
                ? 'runtime-repair-access-link-error'
                : undefined
          }
          onChange={(event) => {
            setFailure(null)
            setAccessLink(event.target.value)
          }}
          placeholder={translate(
            'auto.components.settings.RuntimeHostAccessForm.accessLinkPlaceholder',
            'orca://pair?code=...'
          )}
          className="min-w-0 font-mono"
        />
        {inputError && !parsed.ok ? (
          <p id="runtime-repair-access-link-error" className="text-xs text-destructive">
            {translateHostAccessLinkError(parsed.kind)}
          </p>
        ) : null}
      </div>
      {failure ? (
        <RuntimeHostAccessFailureAlert
          id="runtime-repair-error"
          failure={failure}
          endpoint={parsed.ok ? parsed.value.displayEndpoint : null}
        />
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
          {translate('auto.components.settings.RuntimeHostAccessForm.cancel', 'Cancel')}
        </Button>
        <Button type="submit" disabled={!parsed.ok || busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Link2 />}
          {translate('auto.components.settings.RuntimeRepairDialog.submit', 'Re-pair')}
        </Button>
      </DialogFooter>
    </form>
  )
}
