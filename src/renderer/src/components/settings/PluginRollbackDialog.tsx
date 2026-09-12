import { useRef } from 'react'
import { Loader2 } from 'lucide-react'
import type { PluginHostListEntry } from '../../../../preload/api-types'
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

type PluginRollbackDialogProps = {
  plugin: PluginHostListEntry | null
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (pluginKey: string) => void
}

export function PluginRollbackDialog({
  plugin,
  busy,
  error,
  onCancel,
  onConfirm
}: PluginRollbackDialogProps): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog open={Boolean(plugin)} onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          cancelRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.settings.PluginRollbackDialog.title', 'Roll back plugin?')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.PluginRollbackDialog.description',
              'This deactivates {{value0}} and restores its previous immutable version. If that version requests different access or instructional content, Orca will require another review.',
              { value0: plugin?.name ?? '' }
            )}
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button ref={cancelRef} variant="ghost" disabled={busy} onClick={onCancel}>
            {translate('auto.components.settings.PluginRollbackDialog.cancel', 'Cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !plugin}
            onClick={() => plugin && onConfirm(plugin.pluginKey)}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {translate('auto.components.settings.PluginRollbackDialog.confirm', 'Roll back plugin')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
