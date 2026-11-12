import { useRef } from 'react'
import { Loader2 } from 'lucide-react'
import type { PluginHostListEntry } from '../../../../../preload/api-types'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'

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
  const t = useTranslate()
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog open={Boolean(plugin)} onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent
        surface="security"
        size="compact"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          cancelRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t('auto.components.settings.PluginRemoveDialog.title', 'Remove {{value0}}?', {
              value0: plugin?.name ?? ''
            })}
          </DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.settings.PluginRemoveDialog.description',
              'Its data is removed too.'
            )}{' '}
            {t(
              'auto.components.settings.PluginRemoveDialog.pausesAutomations',
              'Automations it created are paused, and stay paused if you install it again.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={cancelRef} variant="ghost" disabled={busy} onClick={onCancel}>
            {t('auto.components.settings.PluginRemoveDialog.cancel', 'Cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !plugin}
            onClick={() => plugin && onConfirm(plugin.pluginKey)}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t('auto.components.settings.PluginRemoveDialog.remove', 'Remove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
