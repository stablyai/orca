import { DndContext } from '@dnd-kit/core'
import { useAppStore } from '@/store'
import { SplitNode } from '../tab-group/TabGroupSplitLayout'
import { tabGroupBodyAnchorName } from '../tab-group/tab-group-body-anchor'
import { WorkspacePaneStrip } from './WorkspacePaneStrip'
import { resolveWorkspaceView } from '@/store/slices/window-pane-selection'
import { WorkspacePaneActions } from './WorkspacePaneActions'
import { WorkspaceWatchingView } from './WorkspaceWatchingView'
import { ProjectPaneContext } from './ProjectPaneContext'
import { useWorkspacePaneDrag } from './use-workspace-pane-drag'

export function CrossProjectPaneLayout(): React.JSX.Element | null {
  const { overlay, ...drag } = useWorkspacePaneDrag()
  const layout = useAppStore((s) => s.windowPaneLayout)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  useAppStore((s) => s.unifiedTabsByWorktree)
  if (!layout) {
    return null
  }
  const root = layout.expandedPaneId
    ? { type: 'leaf' as const, groupId: layout.expandedPaneId }
    : layout.root
  return (
    <DndContext {...drag}>
      {overlay}
      <div className="flex flex-col flex-1 min-w-0 min-h-0 border-l border-border bg-background p-1.5">
        <div className="h-1 shrink-0" />
        <SplitNode
          node={root}
          nodePath=""
          worktreeId=""
          isWorktreeActive
          focusedGroupId={layout.activePaneId}
          hasSplitGroups={layout.root.type === 'split'}
          touchesTopEdge
          touchesRightEdge
          touchesLeftEdge
          touchesBottomEdge
          suppressLeftBorder
          suppressRightBorder
          suppressBottomBorder
          isTabDragActive={false}
          hoveredTabInsertion={null}
          onSplitRatioChange={useAppStore.getState().setWindowPaneRatio}
          renderPane={(id, reserveCollapsedSidebarHeaderSpace) => {
            const pane = layout.panes[id]
            const focused = id === layout.activePaneId
            const focus = () => useAppStore.getState().focusWindowPane(id)
            return (
              <section
                role="region"
                aria-label="Workspace pane"
                data-pane-id={id}
                data-current={focused}
                className="workspace-pane-region relative flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden rounded-lg border border-border bg-card shadow-xs"
                onPointerDown={focus}
                onFocusCapture={focus}
              >
                <div
                  className={`flex h-[32px] shrink-0 items-stretch rounded-t-lg border-b ${focused && layout.root.type === 'split' ? 'border-ring' : 'border-border'} bg-card`}
                  data-tab-group-strip-id={id}
                >
                  {reserveCollapsedSidebarHeaderSpace && !sidebarOpen && (
                    <div
                      className="shrink-0"
                      style={
                        {
                          width: 'var(--collapsed-sidebar-header-width)',
                          WebkitAppRegion: 'no-drag'
                        } as React.CSSProperties
                      }
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <WorkspacePaneStrip pane={pane} layout={layout} />
                  </div>
                  <WorkspacePaneActions
                    paneId={id}
                    expanded={!!layout.expandedPaneId}
                    split={layout.root.type === 'split'}
                  />
                </div>
                <ProjectPaneContext pane={pane} layout={layout} />
                <div
                  data-tab-group-body-id={id}
                  className="relative flex-1 min-h-0"
                  style={{ anchorName: tabGroupBodyAnchorName(id) } as React.CSSProperties}
                >
                  {pane.selectedViewId &&
                    !resolveWorkspaceView(
                      useAppStore.getState(),
                      layout.views[pane.selectedViewId]
                    ) && <p className="p-4 text-sm text-muted-foreground">Session unavailable</p>}
                  {!pane.selectedViewId && (
                    <p className="p-4 text-sm text-muted-foreground">
                      Select a workspace from the sidebar.
                    </p>
                  )}
                  {pane.selectedViewId && (
                    <WorkspaceWatchingView view={layout.views[pane.selectedViewId]} />
                  )}
                </div>
              </section>
            )
          }}
        />
      </div>
    </DndContext>
  )
}
