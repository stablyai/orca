import { useCallback, useEffect, useState } from 'react'
import { MonitorSmartphone, Share2 } from 'lucide-react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { MachineNameField } from './MachineNameField'
import { RuntimePairingUrlGenerator } from './RuntimePairingUrlGenerator'
import { usePublishedMachineName } from './use-published-machine-name'

/** Desktop only: lets other devices pair with this computer. */
export function RuntimeShareComputerCard(): React.JSX.Element {
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
      // Why: the count is a hint; the dialog reports load failures where they can be acted on.
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
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <MonitorSmartphone className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">
          {translate('auto.components.settings.serverList.shareTitle', 'Share this computer')}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {publishedMachineName
            ? translate(
                'auto.components.settings.serverList.shareDescriptionNamed',
                'Let a browser, phone, or another Orca work on {{name}}.',
                { name: publishedMachineName }
              )
            : translate(
                'auto.components.settings.serverList.shareDescription',
                'Let a browser, phone, or another Orca work on this computer.'
              )}
        </p>
      </div>
      {activeLinkCount ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          {activeLinkCount === 1
            ? translate('auto.components.settings.serverList.oneActiveLink', '1 active link')
            : translate(
                'auto.components.settings.serverList.activeLinks',
                '{{value0}} active links',
                {
                  value0: activeLinkCount
                }
              )}
        </span>
      ) : null}
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Share2 />
        {translate('auto.components.settings.serverList.shareButton', 'Share…')}
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-xl" scrollable>
          <DialogHeader>
            <DialogTitle>
              {translate('auto.components.settings.serverList.shareTitle', 'Share this computer')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.settings.serverList.shareDialogDescriptionRuns',
                'Anyone with the link can run commands as you on this computer until you revoke it.'
              )}
            </DialogDescription>
          </DialogHeader>
          <RuntimePairingUrlGenerator framed={false} showHeader={false} />
          {editingName ? (
            <MachineNameField id="runtime-share-machine-name" />
          ) : (
            <div className="flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
              <span className="min-w-0 truncate">
                {translate(
                  'auto.components.settings.serverList.shownAs',
                  'Shown to others as {{name}}',
                  {
                    name:
                      publishedMachineName ??
                      translate('auto.components.settings.serverList.thisComputer', 'This computer')
                  }
                )}
              </span>
              <span aria-hidden>·</span>
              <button
                type="button"
                className="shrink-0 cursor-pointer rounded-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setEditingName(true)}
              >
                {translate('auto.components.settings.serverList.editName', 'Edit')}
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
              {translate('auto.components.settings.serverList.done', 'Done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
