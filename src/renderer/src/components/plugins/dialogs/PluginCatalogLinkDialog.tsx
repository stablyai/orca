import { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { gitRepositoryOwnerLabel } from '../../../../../shared/plugins/catalog/plugin-marketplace'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'
import type { PluginCatalogToAdd } from '../state/use-plugin-install-link'

/** A plugin link named a catalog the user doesn't have; nothing is fetched until they add it. */
export function PluginCatalogLinkDialog({
  catalog,
  onCancel,
  onConfirm
}: {
  catalog: PluginCatalogToAdd | null
  onCancel: () => void
  onConfirm: () => Promise<void>
}): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const url = catalog?.source.url ?? ''
  const add = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch (cause) {
      console.warn('[plugins] adding a linked catalog failed:', cause)
      setError(
        translate(
          'auto.components.plugins.PluginCatalogLinkDialog.failed',
          'Couldn’t add this catalog.'
        )
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={catalog !== null}
      onOpenChange={(open) => {
        if (!open && !busy) {
          setError(null)
          onCancel()
        }
      }}
    >
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
            {translate(
              'auto.components.plugins.PluginCatalogLinkDialog.title',
              'Add catalog {{value0}}?',
              { value0: gitRepositoryOwnerLabel(url) ?? url }
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.plugins.PluginCatalogLinkDialog.body',
              'A link asked to show {{value0}} from this catalog. Add catalogs only from people you trust.',
              { value0: catalog?.pluginKey ?? '' }
            )}
          </DialogDescription>
        </DialogHeader>
        <p className="break-all font-mono text-xs text-muted-foreground">{url}</p>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button ref={cancelRef} variant="ghost" disabled={busy} onClick={onCancel}>
            {translate('auto.components.plugins.PluginCatalogLinkDialog.cancel', 'Cancel')}
          </Button>
          <Button disabled={busy} onClick={() => void add()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {translate('auto.components.plugins.PluginCatalogLinkDialog.add', 'Add catalog')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
