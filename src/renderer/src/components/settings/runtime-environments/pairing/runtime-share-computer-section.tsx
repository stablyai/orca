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
  DialogTitle
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
    <div data-settings-section="share-computer" className="scroll-mt-8 space-y-2">
      <h3 className="text-sm font-medium">
        {t('auto.components.settings.serverList.thisComputer', 'This computer')}
      </h3>
      <div className="rounded-lg border border-border bg-card">
        {/* ServerListRow's padding and icon column, without its status column, so the text keeps the room. */}
        <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
          <Laptop className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">
              {t('auto.components.settings.serverList.shareTitle', 'Share this computer')}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {activeLinksLabel ??
                t(
                  'auto.components.settings.serverList.shareRowHint',
                  'Let another Orca connect here.'
                )}
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
            {activeLinksLabel
              ? t('auto.components.settings.serverList.manageShare', 'Manage')
              : t('auto.components.settings.serverList.share', 'Share')}
          </Button>
          {/* Keeps the button's right edge on the server rows' action column. */}
          <span aria-hidden className="w-6 shrink-0" />
        </div>
      </div>
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
    </div>
  )
}
