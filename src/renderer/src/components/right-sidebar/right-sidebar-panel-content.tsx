import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import type { ActiveRightSidebarTab } from '@/store/slices/editor'
import { isPluginPanelTabKey } from '../../../../shared/plugins/plugin-manifest'

// reloadKey names the failing chunk on the recovery breadcrumbs and LazyChunkLoadError.
const FileExplorer = lazy(() => import('./FileExplorer'), { reloadKey: 'file-explorer' })
const SourceControl = lazy(() => import('./SourceControl'), { reloadKey: 'source-control' })
const ChecksPanel = lazy(() => import('./ChecksPanel'), { reloadKey: 'checks-panel' })
const PortsPanel = lazy(() => import('./PortsPanel'), { reloadKey: 'ports-panel' })
const AiVaultPanel = lazy(() => import('./AiVaultPanel'), { reloadKey: 'ai-vault-panel' })
const FolderWorkspaceWorktreesPanel = lazy(() => import('./FolderWorkspaceWorktreesPanel'), {
  reloadKey: 'folder-workspace-worktrees-panel'
})
const FolderWorkspacePrChecksPanel = lazy(() => import('./FolderWorkspacePrChecksPanel'), {
  reloadKey: 'folder-workspace-pr-checks-panel'
})
const PluginPanel = lazy(() => import('./PluginPanel'), { reloadKey: 'plugin-panel' })

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
        {effectiveTab === 'source-control' && <SourceControl />}
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
