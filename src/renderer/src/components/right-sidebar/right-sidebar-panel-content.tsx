import { useAppStore } from '@/store/index'
import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { BotChatsSkeleton } from '../bots/BotChatsSkeleton'
import type { ActiveRightSidebarTab } from '../../../../shared/ui-chrome/ui-chrome-types'
import '../../../../shared/plugins/manifest/plugin-manifest'
import { isPluginPanelTabKey } from '../../../../shared/plugins/frames/plugin-tab-key'

const FileExplorer = lazy(() => import('./file-explorer/panel/FileExplorer'))
const FolderWorkspaceSourceControl = lazy(
  () => import('./folder-workspaces/FolderWorkspaceSourceControlPanel')
)
const SourceControl = lazy(() => import('./source-control/panel/SourceControl'))
const ChecksPanel = lazy(() => import('./checks-panel/ChecksPanel'))
const PortsPanel = lazy(() => import('./ports/PortsPanel'))
const AiVaultSidebarPanel = lazy(() => import('./ai-vault/panel/AiVaultSidebarPanel'))
const FolderWorkspaceWorktreesPanel = lazy(
  () => import('./folder-workspaces/FolderWorkspaceWorktreesPanel')
)
const FolderWorkspacePrChecksPanel = lazy(
  () => import('./hosted-review/folder-checks/FolderWorkspacePrChecksPanel')
)
const PluginPanel = lazy(() => import('./plugin-panels/PluginPanel'))
const BotActivityPanel = lazy(() => import('../bots/BotActivityPanel'))
const BotConnectorsPanel = lazy(() => import('../bots/BotConnectorsPanel'))
const BotChatsPanel = lazy(() => import('../bots/BotChatsPanel'))

type RightSidebarPanelContentProps = {
  effectiveTab: ActiveRightSidebarTab
  rightSidebarOpen: boolean
  focusVaultSearch: boolean
  onVaultSearchFocusHandled: () => void
}

export function RightSidebarPanelContent({
  effectiveTab,
  rightSidebarOpen,
  focusVaultSearch,
  onVaultSearchFocusHandled
}: RightSidebarPanelContentProps): React.JSX.Element {
  const isFolderWorkspace = useAppStore(
    (state) => state.activeWorkspaceKey?.startsWith('folder:') ?? false
  )
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      // Bot panel rows open their hover cards outside this rect's left edge, covering nothing in it.
      data-right-sidebar-panel=""
      // `orca plugin shot` captures exactly this rect.
      data-plugin-panel-surface={isPluginPanelTabKey(effectiveTab) ? effectiveTab : undefined}
    >
      <Suspense fallback={effectiveTab === 'bot-chats' ? <BotChatsSkeleton toolbar /> : null}>
        {effectiveTab === 'explorer' && <FileExplorer />}
        {effectiveTab === 'source-control' &&
          (isFolderWorkspace ? (
            rightSidebarOpen && <FolderWorkspaceSourceControl />
          ) : (
            <SourceControl />
          ))}
        {effectiveTab === 'checks' && <ChecksPanel />}
        {/* SSH forwarding needs raw ports.detect data absent from the workspace-scoped status popover. */}
        {effectiveTab === 'ports' && (
          <PortsPanel isVisible={rightSidebarOpen && effectiveTab === 'ports'} />
        )}
        {effectiveTab === 'vault' && (
          <AiVaultSidebarPanel
            focusSearch={focusVaultSearch}
            onFocusSearchHandled={onVaultSearchFocusHandled}
          />
        )}
        {effectiveTab === 'workspaces' && <FolderWorkspaceWorktreesPanel />}
        {effectiveTab === 'pr-checks' && (
          <FolderWorkspacePrChecksPanel
            isVisible={rightSidebarOpen && effectiveTab === 'pr-checks'}
          />
        )}
        {effectiveTab === 'bot-activity' && <BotActivityPanel />}
        {effectiveTab === 'bot-connectors' && <BotConnectorsPanel />}
        {effectiveTab === 'bot-chats' && <BotChatsPanel />}
        {/* Remount on plugin changes so an old iframe cannot post through the next plugin's rebound bridge. */}
        {isPluginPanelTabKey(effectiveTab) && (
          <PluginPanel key={effectiveTab} tabKey={effectiveTab} />
        )}
      </Suspense>
    </div>
  )
}
