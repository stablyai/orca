import { useAppStore } from '@/store'
import type { WorkspaceView } from '../../../../shared/window-pane-types'
import {
  isWorkspaceViewController,
  takeWorkspaceViewControl,
  useWorkspaceViewControlRevision
} from './workspace-view-control-state'
import { WorkspaceTerminalWatcher } from './WorkspaceTerminalWatcher'
import { Button } from '../ui/button'
import { WorkspaceBrowserWatcher } from './WorkspaceBrowserWatcher'
import { parseExecutionHostId } from '../../../../shared/execution-host'

export function WorkspaceWatchingView({ view }: { view: WorkspaceView }) {
  useWorkspaceViewControlRevision()
  const terminal = useAppStore((s) =>
    s.tabsByWorktree[view.worktreeId]?.find((tab) => tab.id === view.entityId)
  )
  const terminalLayout = useAppStore((s) => s.terminalLayoutsByTabId[view.entityId])
  const browser = useAppStore((s) =>
    s.browserTabsByWorktree[view.worktreeId]?.find((tab) => tab.id === view.entityId)
  )
  const page = useAppStore((s) =>
    s.browserPagesByWorkspace[view.entityId]?.find((page) => page.id === browser?.activePageId)
  )
  const pageHandle = useAppStore((s) => page && s.remoteBrowserPageHandlesByPageId[page.id])
  if (!['terminal', 'browser'].includes(view.contentType) || isWorkspaceViewController(view)) {
    return null
  }
  const host = parseExecutionHostId(view.executionHostId)
  const ptyId =
    (terminalLayout?.activeLeafId &&
      terminalLayout.ptyIdsByLeafId?.[terminalLayout.activeLeafId]) ||
    terminal?.ptyId
  return (
    <div className="absolute inset-0 flex flex-col min-h-0 bg-background">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-2 text-xs text-muted-foreground">
        <span>Watching</span>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            void takeWorkspaceViewControl(view)
          }}
        >
          Take Control Here
        </Button>
      </div>
      <div className="flex-1 min-h-0">
        {view.contentType === 'browser' && page ? (
          <WorkspaceBrowserWatcher
            pageId={pageHandle?.remotePageId ?? page.remoteBrowserPageId ?? page.id}
            worktreeId={view.worktreeId}
            environmentId={
              pageHandle?.environmentId ??
              page.browserRuntimeEnvironmentId ??
              (host?.kind === 'runtime' ? host.environmentId : undefined)
            }
          />
        ) : ptyId ? (
          <WorkspaceTerminalWatcher ptyId={ptyId} viewId={view.id} />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">Session unavailable</p>
        )}
      </div>
    </div>
  )
}
