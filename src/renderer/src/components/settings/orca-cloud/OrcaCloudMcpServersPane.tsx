import { useCallback, useEffect, useState } from 'react'
import { Plug } from 'lucide-react'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import type { EphemeralVmRuntimeRecord } from '../../../../../shared/ephemeral-vm-runtimes'
import { CloudApiEmptyState } from '../cloud-api/cloud-api-parts'
import { CloudMcpSyncSection } from '../runtime-environments/cloud-mcp/CloudMcpSyncSection'
import { SettingsGroup } from '../section-layout/SettingsGroup'

/** `name` is null when the workspace record has none; the view shows a generic label. */
export type OrcaCloudMcpWorkspace = {
  runtimeId: string
  name: string | null
  environmentId: string
}

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
      name: record.workspaceName || null,
      environmentId: record.runtimeEnvironmentId as string
    }))
}

export function OrcaCloudMcpServersView({
  workspaces,
  renderSync,
  onRetry
}: {
  /** Null while the runtime list loads; 'failed' when main could not list them. */
  workspaces: OrcaCloudMcpWorkspace[] | null | 'failed'
  renderSync: (workspace: OrcaCloudMcpWorkspace, onlyOne: boolean) => React.ReactNode
  onRetry: () => void
}): React.JSX.Element {
  const t = useTranslate()
  if (workspaces === 'failed') {
    return (
      <InlineError
        title={t('settings.orcaCloud.mcp.loadFailed', 'Couldn’t list your cloud workspaces')}
        retryLabel={t('cloudEnvironment.retry', 'Try again')}
        onRetry={onRetry}
      />
    )
  }
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
      {workspaces.map((workspace) => {
        const name = workspace.name ?? t('settings.orcaCloud.mcp.unnamed', 'Cloud workspace')
        return (
          <SettingsGroup key={workspace.runtimeId}>
            <section
              className="py-3"
              aria-label={t('settings.orcaCloud.mcp.workspaceLabel', 'MCP servers in {{name}}', {
                name
              })}
            >
              <p className="truncate text-sm font-medium">{name}</p>
              {renderSync(workspace, workspaces.length === 1)}
            </section>
          </SettingsGroup>
        )
      })}
    </div>
  )
}

export function OrcaCloudMcpServersPane(): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<OrcaCloudMcpWorkspace[] | null | 'failed'>(null)
  const [attempt, setAttempt] = useState(0)
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
      .catch(() => !disposed && setWorkspaces('failed'))
    return () => {
      disposed = true
    }
  }, [lifecycle, attempt])
  const retry = useCallback(() => {
    setWorkspaces(null)
    setAttempt((value) => value + 1)
  }, [])
  return (
    <OrcaCloudMcpServersView
      workspaces={workspaces}
      onRetry={retry}
      renderSync={(workspace, onlyOne) => (
        <CloudMcpSyncSection environmentId={workspace.environmentId} defaultExpanded={onlyOne} />
      )}
    />
  )
}
