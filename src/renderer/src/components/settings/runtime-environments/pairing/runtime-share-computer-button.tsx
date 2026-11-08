import { useCallback, useEffect, useState } from 'react'
import { Share2 } from 'lucide-react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { Button } from '../../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../ui/dialog'
import { MachineNameField } from '../../../machine-identity/MachineNameField'
import { RuntimePairingUrlGenerator } from './RuntimePairingUrlGenerator'
import { usePublishedMachineName } from '../../../machine-identity/use-published-machine-name'

/** Desktop only: lets other devices pair with this computer. */
export function RuntimeShareComputerButton(): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [activeLinkCount, setActiveLinkCount] = useState<number | null>(null)
  const mountedRef = useMountedRef()
  const machineName = useAppStore((state) => state.settings?.machineName ?? '')
  const publishedMachineName = usePublishedMachineName(machineName)

  const loadActiveLinkCount = useCallback(async () => {
    try {
      const result = await window.api.mobile.listRuntimeAccessGrants()
      if (mountedRef.current) {
        setActiveLinkCount(result.grants.length)
      }
    } catch {
      // Counts are hints; the dialog reports actionable load failures.
    }
  }, [mountedRef])
  useEffect(() => {
    void loadActiveLinkCount()
  }, [loadActiveLinkCount])

  const handleOpenChange = (next: boolean): void => {
    setOpen(next)
    if (!next) {
      setEditingName(false)
      void loadActiveLinkCount()
    }
  }

  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <Share2 />
        {t('auto.components.settings.serverList.shareTitle', 'Share this computer')}
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-xl" scrollable>
          <DialogHeader>
            <DialogTitle>
              {t('auto.components.settings.serverList.shareTitle', 'Share this computer')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'auto.components.settings.serverList.shareDialogDescriptionRuns',
                'Anyone with the link can run commands as you on this computer until you revoke it.'
              )}
            </DialogDescription>
          </DialogHeader>
          {activeLinkCount ? (
            <p className="text-xs text-muted-foreground">
              {activeLinkCount === 1
                ? t('auto.components.settings.serverList.oneActiveLink', '1 active link')
                : t('auto.components.settings.serverList.activeLinks', '{{value0}} active links', {
                    value0: activeLinkCount
                  })}
            </p>
          ) : null}
          <RuntimePairingUrlGenerator framed={false} showHeader={false} />
          {editingName ? (
            <MachineNameField id="runtime-share-machine-name" />
          ) : (
            <div className="flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
              <span className="min-w-0 truncate">
                {t('auto.components.settings.serverList.shownAs', 'Shown to others as {{name}}', {
                  name:
                    publishedMachineName ??
                    t('auto.components.settings.serverList.thisComputer', 'This computer')
                })}
              </span>
              <span aria-hidden>·</span>
              <button
                type="button"
                className="shrink-0 cursor-pointer rounded-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setEditingName(true)}
              >
                {t('auto.components.settings.serverList.editName', 'Edit')}
              </button>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => handleOpenChange(false)}
            >
              {t('auto.components.settings.serverList.done', 'Done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
