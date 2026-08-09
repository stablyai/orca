import React, { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import type { ActiveRightSidebarTab } from '@/store/slices/editor'
import { useAppStore } from '@/store'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { isPluginPanelTabKey } from '../../../../shared/plugins/plugin-manifest'
import { useFolderSourceControlScope } from './use-folder-source-control-scope'

const FileExplorer = lazy(() => import('./FileExplorer'))
const SourceControl = lazy(() => import('./SourceControl'))
const FolderSourceControl = lazy(() => import('./FolderSourceControl'))
const ChecksPanel = lazy(() => import('./ChecksPanel'))
const PortsPanel = lazy(() => import('./PortsPanel'))
const AiVaultPanel = lazy(() => import('./AiVaultPanel'))
const FolderWorkspaceWorktreesPanel = lazy(() => import('./FolderWorkspaceWorktreesPanel'))
const FolderWorkspacePrChecksPanel = lazy(() => import('./FolderWorkspacePrChecksPanel'))
const PluginPanel = lazy(() => import('./PluginPanel'))

/** Routes Source Control to folder or worktree source-control panels. */
function SourceControlPanelRoute(): React.JSX.Element {
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const activeWorktree = useActiveWorktree()
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)
  const isFolderScope = useFolderSourceControlScope(activeWorktreeId, activeRepo)

  if (isFolderScope) {
    return <FolderSourceControl />
  }
  return <SourceControl />
}

type RightSidebarPanelContentProps = {
  effectiveTab: ActiveRightSidebarTab
  rightSidebarOpen: boolean
}

export function RightSidebarPanelContent({
  effectiveTab,
  rightSidebarOpen
}: RightSidebarPanelContentProps): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Suspense fallback={null}>
        {effectiveTab === 'explorer' && <FileExplorer />}
        {effectiveTab === 'source-control' && <SourceControlPanelRoute />}
        {effectiveTab === 'checks' && <ChecksPanel />}
        {/* Why: SSH port forwarding still depends on the raw ports.detect data,
            which the workspace-scoped status bar popover intentionally does not
            expose. Keep this panel reachable only for SSH worktrees. */}
        {effectiveTab === 'ports' && (
          <PortsPanel isVisible={rightSidebarOpen && effectiveTab === 'ports'} />
        )}
        {effectiveTab === 'vault' && <AiVaultPanel />}
        {effectiveTab === 'workspaces' && <FolderWorkspaceWorktreesPanel />}
        {effectiveTab === 'pr-checks' && (
          <FolderWorkspacePrChecksPanel
            isVisible={rightSidebarOpen && effectiveTab === 'pr-checks'}
          />
        )}
        {/* Plugin-contributed tabs route by key prefix; the panel itself
            handles plugins that have since been uninstalled or disabled.
            Why key: switching plugin tabs must remount the sandboxed iframe —
            a reused frame could keep posting messages while the bridge is
            rebound under the next plugin's identity. */}
        {isPluginPanelTabKey(effectiveTab) && (
          <PluginPanel key={effectiveTab} tabKey={effectiveTab} />
        )}
      </Suspense>
    </div>
  )
}
