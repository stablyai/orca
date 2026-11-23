import { useCallback, useEffect, useState } from 'react'
import { Laptop } from 'lucide-react'
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
  DialogTitle,
  DialogTrigger
} from '../../../ui/dialog'
import { MachineNameField } from '../../../machine-identity/MachineNameField'
import { RuntimePairingUrlGenerator } from './RuntimePairingUrlGenerator'
import { usePublishedMachineName } from '../../../machine-identity/use-published-machine-name'

/** Desktop only: the block under the server list that lets other devices pair with this computer. */
export function RuntimeShareComputerSection(): React.JSX.Element {
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

  const activeLinksLabel = !activeLinkCount
    ? null
    : activeLinkCount === 1
      ? t('auto.components.settings.serverList.oneActiveLink', '1 active link')
      : t('auto.components.settings.serverList.activeLinks', '{{value0}} active links', {
          value0: activeLinkCount
        })

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <div data-settings-section="share-computer" className="scroll-mt-8 space-y-2">
        <h3 className="text-settings-heading font-semibold">
          {t('auto.components.settings.serverList.thisComputer', 'This computer')}
        </h3>
        <div className="@container/share-computer rounded-lg border border-border bg-card">
          <div className="grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 px-4 py-2.5 @max-xs/share-computer:gap-y-1">
            <Laptop
              aria-hidden
              className="col-start-1 row-start-1 size-4 text-muted-foreground @xs/share-computer:row-span-2"
            />
            <div className="col-start-2 row-start-1 truncate text-sm font-medium @max-xs/share-computer:col-span-2">
              {t('auto.components.settings.serverList.shareTitle', 'Share this computer')}
            </div>
            <div className="col-start-2 row-start-2 truncate text-xs text-muted-foreground">
              {activeLinksLabel ??
                t(
                  'auto.components.settings.serverList.shareRowHint',
                  'Let another Orca connect here.'
                )}
            </div>
            <DialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="col-start-3 row-start-2 justify-self-end @xs/share-computer:row-span-2 @xs/share-computer:row-start-1"
              >
                {activeLinksLabel
                  ? t('auto.components.settings.serverList.manageShare', 'Manage')
                  : t('auto.components.settings.serverList.share', 'Share')}
              </Button>
            </DialogTrigger>
          </div>
        </div>
      </div>
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
        {activeLinksLabel ? (
          <p className="text-xs text-muted-foreground">{activeLinksLabel}</p>
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
          <Button type="button" variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
            {t('auto.components.settings.serverList.done', 'Done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
