import { useState } from 'react'
import { useAppStore } from '@/store'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
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
  const [isTakingControl, setIsTakingControl] = useState(false)
  const [controlRequestFailed, setControlRequestFailed] = useState(false)
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
  const takeControl = async (): Promise<void> => {
    if (isTakingControl) {
      return
    }
    setIsTakingControl(true)
    setControlRequestFailed(false)
    try {
      const state = useAppStore.getState()
      const layout = state.windowPaneLayout
      const owningPane = layout
        ? Object.values(layout.panes).find((pane) => pane.viewIds.includes(view.id))
        : undefined
      if (owningPane) {
        state.focusWindowPane(owningPane.id, view.id)
      }
      const claimed = await takeWorkspaceViewControl(view)
      if (!claimed) {
        setControlRequestFailed(true)
        return
      }
      if (view.contentType === 'terminal') {
        const nextState = useAppStore.getState()
        const activeLeafId = nextState.terminalLayoutsByTabId[view.entityId]?.activeLeafId ?? null
        activateTabAndFocusPane(view.tabId, activeLeafId)
      }
    } catch {
      setControlRequestFailed(true)
    } finally {
      setIsTakingControl(false)
    }
  }
  const host = parseExecutionHostId(view.executionHostId)
  const ptyId =
    (terminalLayout?.activeLeafId &&
      terminalLayout.ptyIdsByLeafId?.[terminalLayout.activeLeafId]) ||
    terminal?.ptyId
  return (
    <div className="absolute inset-0 flex flex-col min-h-0 bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/30 px-2 py-0.5 text-xs text-muted-foreground">
        <span className="shrink-0 font-medium text-foreground">Read-only</span>
        <span className="min-w-0 flex-1 truncate">
          {controlRequestFailed
            ? 'Control request failed. Try again or close the other window.'
            : 'This session is active in another window.'}
        </span>
        <Button
          variant="secondary"
          size="xs"
          disabled={isTakingControl}
          onClick={() => void takeControl()}
        >
          {isTakingControl ? 'Taking control…' : 'Take control here'}
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
