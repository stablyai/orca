import { useEffect, useState } from 'react'
import { Plug } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import type { EphemeralVmRuntimeRecord } from '../../../../../shared/ephemeral-vm-runtimes'
import { CloudApiEmptyState } from '../cloud-api/cloud-api-parts'
import { CloudMcpSyncSection } from '../runtime-environments/cloud-mcp/CloudMcpSyncSection'
import { SettingsGroup } from '../section-layout/SettingsGroup'

export type OrcaCloudMcpWorkspace = { runtimeId: string; name: string; environmentId: string }

/** Running Orca Cloud workspaces, newest first: MCP sync only reaches a sandbox that is awake. */
export function runningOrcaCloudMcpWorkspaces(
  records: readonly EphemeralVmRuntimeRecord[]
): OrcaCloudMcpWorkspace[] {
  return records
    .filter(
      (record) =>
        record.recipe?.provider === 'orca-cloud' &&
        record.status === 'running' &&
        Boolean(record.runtimeEnvironmentId)
    )
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .map((record) => ({
      runtimeId: record.id,
      name: record.workspaceName || record.recipeId,
      environmentId: record.runtimeEnvironmentId as string
    }))
}

export function OrcaCloudMcpServersView({
  workspaces,
  renderSync
}: {
  /** Null while the runtime list loads. */
  workspaces: OrcaCloudMcpWorkspace[] | null
  renderSync: (workspace: OrcaCloudMcpWorkspace, onlyOne: boolean) => React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  if (workspaces === null) {
    return (
      <div className="space-y-3" aria-busy>
        <span className="sr-only">{t('cloudMcpSync.loading', 'Loading MCP servers…')}</span>
        <Skeleton className="h-20 w-full" />
      </div>
    )
  }
  if (workspaces.length === 0) {
    return (
      <SettingsGroup>
        <CloudApiEmptyState
          icon={Plug}
          title={t('settings.orcaCloud.mcp.emptyTitle', 'No cloud workspace is running')}
          description={t(
            'settings.orcaCloud.mcp.emptyBody',
            'MCP servers sync to a cloud workspace while it runs. Start or wake one to choose which servers it gets.'
          )}
        />
      </SettingsGroup>
    )
  }
  return (
    <div className="space-y-3">
      {workspaces.map((workspace) => (
        <SettingsGroup key={workspace.runtimeId}>
          <section
            className="px-4 py-3"
            aria-label={t('settings.orcaCloud.mcp.workspaceLabel', 'MCP servers in {{name}}', {
              name: workspace.name
            })}
          >
            <p className="truncate text-sm font-medium">{workspace.name}</p>
            {renderSync(workspace, workspaces.length === 1)}
          </section>
        </SettingsGroup>
      ))}
    </div>
  )
}

export function OrcaCloudMcpServersPane(): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<OrcaCloudMcpWorkspace[] | null>(null)
  // The store mirrors every lifecycle broadcast, so a change there means the list moved.
  const lifecycle = useAppStore((s) => s.ephemeralVmRuntimesByWorkspaceId)
  useEffect(() => {
    const listRuntimes = window.api.ephemeralVm?.listRuntimes
    if (!listRuntimes) {
      setWorkspaces([])
      return
    }
    let disposed = false
    void listRuntimes()
      .then((records) => !disposed && setWorkspaces(runningOrcaCloudMcpWorkspaces(records)))
      .catch(() => !disposed && setWorkspaces([]))
    return () => {
      disposed = true
    }
  }, [lifecycle])
  return (
    <OrcaCloudMcpServersView
      workspaces={workspaces}
      renderSync={(workspace, onlyOne) => (
        <CloudMcpSyncSection environmentId={workspace.environmentId} defaultExpanded={onlyOne} />
      )}
    />
  )
}
