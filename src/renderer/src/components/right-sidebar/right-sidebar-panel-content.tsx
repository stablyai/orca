import { lazy, Suspense } from 'react'
import type { ActiveRightSidebarTab } from '@/store/slices/editor'

const FileExplorer = lazy(() => import('./FileExplorer'))
const SourceControl = lazy(() => import('./SourceControl'))
const ChecksPanel = lazy(() => import('./ChecksPanel'))
const PortsPanel = lazy(() => import('./PortsPanel'))
const AiVaultPanel = lazy(() => import('./AiVaultPanel'))
const FolderWorkspaceWorktreesPanel = lazy(() => import('./FolderWorkspaceWorktreesPanel'))
const FolderWorkspacePrChecksPanel = lazy(() => import('./FolderWorkspacePrChecksPanel'))

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
      </Suspense>
    </div>
  )
}
