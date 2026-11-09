import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import {
  syncCloudMcpServersNow,
  useCloudMcpSyncStatus
} from '@/lib/cloud-mcp-sync/cloud-mcp-sync-client'
import { CloudMcpSyncPanel } from './CloudMcpSyncPanel'

/** Renders only for Orca Cloud workspaces; main answers null for every other host. */
export function CloudMcpSyncSection({
  environmentId
}: {
  environmentId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const status = useCloudMcpSyncStatus(environmentId, true)
  const [expanded, setExpanded] = useState(false)
  if (!status) {
    return null
  }
  const syncNow = (): void => {
    void syncCloudMcpServersNow(environmentId).catch(() =>
      toast.error(t('cloudMcpSync.error.failed', 'The last sync didn’t finish.'))
    )
  }
  return (
    <CloudMcpSyncPanel
      status={status}
      expanded={expanded}
      onToggleExpanded={() => setExpanded((value) => !value)}
      onSyncNow={syncNow}
      onToggleServer={(key, included) => {
        const preferences = window.api.runtimeEnvironments
        void preferences
          .getMcpSyncPreferences?.()
          .then((current) => {
            const excluded = new Set(current?.excluded ?? [])
            if (included) {
              excluded.delete(key)
            } else {
              excluded.add(key)
            }
            return preferences.setMcpSyncPreferences?.({ excluded: [...excluded] })
          })
          // Turning a server off removes it from the workspace too, so apply right away.
          .then(syncNow)
      }}
      onToggleAutoSync={(autoSync) =>
        void window.api.runtimeEnvironments.setMcpSyncPreferences?.({ autoSync })
      }
    />
  )
}
