import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { mutateAgentCatalog } from '@/lib/agent-catalog-authoring'
import { translate } from '@/i18n/i18n'

export type CustomAgentRepairTarget = {
  repairToken: string
  label: string | null
}

export type CustomAgentRepairDialogProps = {
  open: boolean
  target: CustomAgentRepairTarget
  onOpenChange: (open: boolean) => void
  /** Opens the editor in repair-replace mode to author the replacement agent. */
  onReplaceAsNew: () => void
  onDiscarded: () => void
}

/** Repair form for a malformed, non-addressable custom row (plan §972): it can
 *  only be discarded or replaced by a freshly authored agent, and either action
 *  is irreversible and does not rebind saved references. */
export function CustomAgentRepairDialog({
  open,
  target,
  onOpenChange,
  onReplaceAsNew,
  onDiscarded
}: CustomAgentRepairDialogProps): React.JSX.Element {
  const [discarding, setDiscarding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label =
    target.label ??
    translate('auto.components.settings.CustomAgentRepairDialog.fallbackLabel', 'this custom agent')

  const confirmDiscard = async (): Promise<void> => {
    setDiscarding(true)
    setError(null)
    const result = await mutateAgentCatalog({
      kind: 'repair-corrupt',
      repairToken: target.repairToken,
      action: { kind: 'discard' }
    })
    setDiscarding(false)
    if (!result.ok) {
      setError(
        translate(
          'auto.components.settings.CustomAgentRepairDialog.discardError',
          'Could not discard this row. Reopen Settings and try again.'
        )
      )
      return
    }
    onDiscarded()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle>
            {translate(
              'auto.components.settings.CustomAgentRepairDialog.title',
              'Repair {{label}}',
              {
                label
              }
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.CustomAgentRepairDialog.description',
              "This definition is corrupt and can't be edited in place. Replace it with a new agent or discard it."
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-4 scrollbar-sleek overflow-y-auto px-6 py-4">
          <p className="text-sm text-muted-foreground">
            {translate(
              'auto.components.settings.CustomAgentRepairDialog.referencesNote',
              'Saved references keep pointing at the old agent — they are not rebound to a replacement. Both actions are permanent.'
            )}
          </p>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter className="flex-col gap-2 border-t border-border px-6 py-4 sm:flex-row sm:justify-between">
          <Button type="button" variant="outline" onClick={onReplaceAsNew} disabled={discarding}>
            {translate(
              'auto.components.settings.CustomAgentRepairDialog.replaceAsNew',
              'Replace as new agent'
            )}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={discarding}
            onClick={() => void confirmDiscard()}
          >
            {translate(
              'auto.components.settings.CustomAgentRepairDialog.discard',
              'Discard corrupt row'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
