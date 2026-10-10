import { useSyncExternalStore } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { codexMaintenanceTargetKey } from '@/lib/codex-maintenance-client'
import { CODEX_INSTALL_COMMAND } from '../../../../shared/codex-cli-maintenance'
import {
  getCodexMaintenanceEntry,
  getCodexMaintenanceHostBusy,
  getCodexMaintenanceLogTarget,
  openCodexMaintenanceLog,
  subscribeCodexMaintenance
} from '@/lib/codex-maintenance-store'
import { codexMaintenanceLabel } from './codex-maintenance-copy'
import { NativeChatCopyButton } from './NativeChatCopyButton'

export function CodexMaintenanceLogDialog(): React.JSX.Element {
  const target = useSyncExternalStore(
    subscribeCodexMaintenance,
    getCodexMaintenanceLogTarget,
    getCodexMaintenanceLogTarget
  )
  const snapshot = () => getCodexMaintenanceEntry(target ? codexMaintenanceTargetKey(target) : '')
  const entry = useSyncExternalStore(subscribeCodexMaintenance, snapshot, snapshot)
  const job = entry.logJob
  const busySnapshot = () => Boolean(target && getCodexMaintenanceHostBusy(target))
  const busy = useSyncExternalStore(subscribeCodexMaintenance, busySnapshot, busySnapshot)
  const message =
    entry.error || job?.error
      ? translate('codex.maintenance.installFailed', 'Codex could not be installed. Try again.')
      : job?.phase === 'completed'
        ? translate('codex.maintenance.exitCode', 'Command exited with code {{code}}', {
            code: job.exitCode ?? '?'
          })
        : !busy || job?.phase === 'unknown'
          ? CODEX_INSTALL_COMMAND
          : codexMaintenanceLabel(true)
  const output = job?.output ?? ''
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          openCodexMaintenanceLog(null)
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{translate('codex.maintenance.logTitle', 'Codex setup log')}</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        {busy ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
        <div className="relative overflow-hidden rounded-md border border-border bg-muted">
          <pre className="scrollbar-sleek max-h-80 min-h-32 overflow-auto whitespace-pre-wrap break-words p-3 pr-10 font-mono text-xs text-foreground">
            {output}
          </pre>
          <NativeChatCopyButton
            text={output}
            label={translate('codex.maintenance.copyLog', 'Copy log')}
            className="absolute right-1 top-1"
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
