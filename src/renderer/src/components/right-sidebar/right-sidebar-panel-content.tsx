import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { useIsOrchestratorActiveWorktree } from '@/lib/use-orchestrator-active-worktree'
import type { ActiveRightSidebarTab } from '@/store/slices/editor'

const FileExplorer = lazy(() => import('./FileExplorer'))
const SourceControl = lazy(() => import('./SourceControl'))
const ChecksPanel = lazy(() => import('./ChecksPanel'))
const PortsPanel = lazy(() => import('./PortsPanel'))
const AiVaultPanel = lazy(() => import('./AiVaultPanel'))
const FolderWorkspaceWorktreesPanel = lazy(() => import('./FolderWorkspaceWorktreesPanel'))
const FolderWorkspacePrChecksPanel = lazy(() => import('./FolderWorkspacePrChecksPanel'))
const OrchestratorPanelNotice = lazy(() => import('./OrchestratorPanelNotice'))

type RightSidebarPanelContentProps = {
  effectiveTab: ActiveRightSidebarTab
  rightSidebarOpen: boolean
}

export function RightSidebarPanelContent({
  effectiveTab,
  rightSidebarOpen
}: RightSidebarPanelContentProps): React.JSX.Element {
  // Why: the Checks panel is PR-centric; a director has no PR of its own, so
  // route it to the director notice instead of a misleading "Branch not
  // published" state. Source Control handles its own director view (Mission
  // Control); files/ports/vault are honest as-is for a coordination worktree.
  const isDirector = useIsOrchestratorActiveWorktree()
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Suspense fallback={null}>
        {effectiveTab === 'explorer' && <FileExplorer />}
        {effectiveTab === 'source-control' && <SourceControl />}
        {effectiveTab === 'checks' && (isDirector ? <OrchestratorPanelNotice /> : <ChecksPanel />)}
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
      </Suspense>
    </div>
  )
}
