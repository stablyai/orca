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

type PluginRemoveDialogProps = {
  plugin: PluginHostListEntry | null
  busy: boolean
  onCancel: () => void
  onConfirm: (pluginKey: string) => void
}

export function PluginRemoveDialog({
  plugin,
  busy,
  onCancel,
  onConfirm
}: PluginRemoveDialogProps): React.JSX.Element {
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
            {translate('auto.components.settings.PluginRemoveDialog.title', 'Remove plugin?')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.PluginRemoveDialog.description',
              'This removes {{value0}} and its stored plugin data from this computer. You can install it again later.',
              { value0: plugin?.name ?? '' }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={cancelRef} variant="ghost" disabled={busy} onClick={onCancel}>
            {translate('auto.components.settings.PluginRemoveDialog.cancel', 'Cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !plugin}
            onClick={() => plugin && onConfirm(plugin.pluginKey)}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {translate('auto.components.settings.PluginRemoveDialog.remove', 'Remove plugin')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
