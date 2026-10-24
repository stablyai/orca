import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
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

type RemovedAliases =
  | { status: 'loading' }
  | { status: 'ready'; aliases: string[] }
  | { status: 'unavailable' }

/** Confirms bringing back ~/.ssh/config hosts that were removed in Orca, naming them first. */
export function SshRestoreRemovedHostsDialog({
  open,
  busy,
  onOpenChange,
  onConfirm
}: {
  open: boolean
  busy: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void | Promise<void>
}): React.JSX.Element {
  const [removed, setRemoved] = useState<RemovedAliases>({ status: 'loading' })

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    // Why: a restore closes this dialog from outside, so a reopen must not show the last list.
    setRemoved({ status: 'loading' })
    window.api.ssh
      .listConfigHosts({ refresh: true })
      .then((result) => {
        if (!cancelled) {
          const aliases = result.hosts.filter((host) => host.previouslyRemoved)
          setRemoved({ status: 'ready', aliases: aliases.map((host) => host.alias) })
        }
      })
      // Why: the list only informs the confirm; restore still works when it can't be read.
      .catch(() => !cancelled && setRemoved({ status: 'unavailable' }))
    return () => {
      cancelled = true
    }
  }, [open])

  const aliases = removed.status === 'ready' ? removed.aliases : []
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) {
          return
        }
        if (!next) {
          setRemoved({ status: 'loading' })
        }
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.SshRestoreRemovedHosts.title',
              'Restore removed hosts?'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.SshRestoreRemovedHosts.description',
              'Hosts from ~/.ssh/config that you removed in Orca come back in Settings and in every host picker.'
            )}
          </DialogDescription>
        </DialogHeader>
        {removed.status === 'unavailable' ? null : (
          <div className="scrollbar-sleek max-h-32 overflow-y-auto rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
            {removed.status === 'loading' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : aliases.length > 0 ? (
              <span className="break-all">{aliases.join(', ')}</span>
            ) : (
              translate(
                'auto.components.settings.SshRestoreRemovedHosts.none',
                'No removed hosts from ~/.ssh/config.'
              )
            )}
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setRemoved({ status: 'loading' })
              onOpenChange(false)
            }}
            disabled={busy}
          >
            {translate('auto.components.settings.SshDestructiveActionDialog.895b216267', 'Cancel')}
          </Button>
          <Button
            onClick={() => void onConfirm()}
            disabled={
              busy ||
              removed.status === 'loading' ||
              (removed.status === 'ready' && aliases.length === 0)
            }
            className="gap-1.5"
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : null}
            {translate('auto.components.settings.SshRestoreRemovedHosts.confirm', 'Restore')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
