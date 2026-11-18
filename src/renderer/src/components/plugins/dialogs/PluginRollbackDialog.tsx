import { useRef } from 'react'
import { Loader2 } from 'lucide-react'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import { usePluginRollbackVersion } from '../state/use-plugin-rollback-version'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'

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
  const t = useTranslate()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const version = usePluginRollbackVersion(plugin?.pluginKey ?? null)
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
            {t('auto.components.settings.PluginRollbackDialog.title', 'Roll back {{value0}}?', {
              value0: plugin?.name ?? ''
            })}
          </DialogTitle>
          <DialogDescription>
            {version
              ? t(
                  'auto.components.settings.PluginRollbackDialog.descriptionVersion',
                  'Restores version {{value0}}.',
                  { value0: version }
                )
              : t(
                  'auto.components.settings.PluginRollbackDialog.description',
                  'Restores the previous version.'
                )}
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button ref={cancelRef} variant="ghost" disabled={busy} onClick={onCancel}>
            {t('auto.components.settings.PluginRollbackDialog.cancel', 'Cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !plugin}
            onClick={() => plugin && onConfirm(plugin.pluginKey)}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t('auto.components.settings.PluginRollbackDialog.confirm', 'Roll back')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
