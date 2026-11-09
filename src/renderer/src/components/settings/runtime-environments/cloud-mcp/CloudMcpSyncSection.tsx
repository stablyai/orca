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
    toast.error(t('cloudMcpSync.error.failed', 'The last sync didn’t finish.'))
  }
  const syncNow = (): void => {
    void syncCloudMcpServersNow(environmentId).catch(failed)
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
        void Promise.resolve(api.setMcpServerIncluded?.(key, included))
          .then(() => syncCloudMcpServersNow(environmentId))
          .catch(failed)
      }}
      onToggleAutoSync={(autoSync) => {
        void Promise.resolve(api.setMcpSyncPreferences?.({ autoSync })).catch(failed)
      }}
    />
  )
}
