import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import {
  syncCloudMcpServersNow,
  useCloudMcpSyncStatus
} from '@/lib/cloud-mcp-sync/cloud-mcp-sync-client'
import { CloudMcpSyncPanel, CloudMcpSyncSkeleton } from './CloudMcpSyncPanel'

/** Renders only for Orca Cloud workspaces; main answers null for every other host. */
export function CloudMcpSyncSection({
  environmentId
}: {
  environmentId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const status = useCloudMcpSyncStatus(environmentId, true)
  const [expanded, setExpanded] = useState(false)
  if (status === undefined) {
    return <CloudMcpSyncSkeleton />
  }
  if (!status) {
    return null
  }
  const failed = (): void => {
    toast.error(t('cloudMcpSync.saveFailed', 'Couldn’t save the change.'))
  }
  const syncNow = (): void => {
    void syncCloudMcpServersNow(environmentId).catch(() =>
      toast.error(t('cloudMcpSync.startFailed', 'Couldn’t start the sync.'))
    )
  }
  const api = window.api.runtimeEnvironments
  return (
    <CloudMcpSyncPanel
      status={status}
      expanded={expanded}
      onToggleExpanded={() => setExpanded((value) => !value)}
      onSyncNow={syncNow}
      onToggleServer={(key, included) => {
        // Main flips the switch everywhere at once; turning one off also removes it from the workspace.
        // Main re-syncs every workspace that last synced cleanly; only this one otherwise.
        const mainSyncs = status.error === null && status.lastSyncedAt !== null
        void Promise.resolve(api.setMcpServerIncluded?.(key, included))
          .then(() => (mainSyncs ? undefined : syncNow()))
          .catch(failed)
      }}
      onToggleAutoSync={(autoSync) => {
        void Promise.resolve(api.setMcpSyncPreferences?.({ autoSync })).catch(failed)
      }}
    />
  )
}
