import { useSyncExternalStore } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCodexMaintenance } from '@/hooks/useCodexMaintenance'
import type { CodexMaintenanceTarget } from '@/lib/codex-maintenance-client'
import {
  getCodexMaintenanceHostBusy,
  startCodexMaintenance,
  subscribeCodexMaintenance
} from '@/lib/codex-maintenance-store'
import {
  codexMaintenanceLabel,
  codexMaintenanceSettingsStatus
} from '../native-chat/codex-maintenance-copy'

export function CodexMaintenanceRow({
  target
}: {
  target: CodexMaintenanceTarget
}): React.JSX.Element | null {
  const maintenance = useCodexMaintenance(target)
  const busySnapshot = () => getCodexMaintenanceHostBusy(target)
  const hostBusy = useSyncExternalStore(subscribeCodexMaintenance, busySnapshot, busySnapshot)
  const installation = maintenance.installation
  const status = installation ? codexMaintenanceSettingsStatus(installation) : null
  if (!status) {
    return null
  }
  const busy = hostBusy || maintenance.starting
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{status}</span>
      {/* Only a missing Codex gets a button; the user updates an old one themselves. */}
      {installation?.status === 'missing' && maintenance.state?.canRun ? (
        <Button
          variant="outline"
          size="xs"
          disabled={busy}
          onClick={() => startCodexMaintenance(target)}
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : null}
          {codexMaintenanceLabel(busy)}
        </Button>
      ) : null}
    </div>
  )
}
