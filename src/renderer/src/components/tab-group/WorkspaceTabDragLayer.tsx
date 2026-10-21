import { DndContext, DragOverlay } from '@dnd-kit/core'
import TabDragPreview from '../tab-bar/TabDragPreview'
import { TabDragProvider } from './tab-drag-context'
import TabPaneColumnSplitDragOverlay from './TabPaneColumnSplitDragOverlay'
import { useTabDragSplit, type HoveredTabInsertion } from './useTabDragSplit'

export type WorkspaceTabDragState = {
  isTabDragActive: boolean
  hoveredTabInsertion: HoveredTabInsertion | null
  setDragRootNode: (node: HTMLDivElement | null) => void
}

/**
 * The one dnd-kit scope for a workspace's tab strips and split tree. Every strip and pane-body
 * droppable of the workspace must render inside it — two live DndContexts over the same tabs is
 * the drag-ownership bug this layer exists to prevent.
 *
 * Chrome-agnostic: children decide where strips and the tree render (per-group strips for the
 * main surface, a shell-owned titlebar strip for the floating panel).
 */
export function WorkspaceTabDragLayer({
  worktreeId,
  enabled,
  children
}: {
  worktreeId: string
  /** False while hidden: a concealed surface must not register sensors that compete with the visible one. */
  enabled: boolean
  children: (drag: WorkspaceTabDragState) => React.ReactNode
}): React.JSX.Element {
  const dragSplit = useTabDragSplit({ worktreeId, enabled })

  return (
    <TabDragProvider
      isTabDragActive={dragSplit.activeDrag !== null}
      isTabDragActiveRef={dragSplit.isTabDragActiveRef}
    >
      <DndContext
        sensors={dragSplit.sensors}
        collisionDetection={dragSplit.collisionDetection}
        onDragStart={dragSplit.onDragStart}
        onDragMove={dragSplit.onDragMove}
        onDragOver={dragSplit.onDragOver}
        onDragEnd={dragSplit.onDragEnd}
        onDragCancel={dragSplit.onDragCancel}
        // Why: dnd-kit auto-scrolls the tab strip when the cursor approaches its
        // edge, which in a multi-group layout creates a feedback loop — scroll
        // shifts tabs under the cursor, `over` re-resolves, scroll runs again.
        // We don't need autoscroll for tab-bar drags (strip fits the viewport),
        // so disabling it is the simplest fix.
        autoScroll={false}
      >
        {children({
          isTabDragActive: dragSplit.activeDrag !== null,
          hoveredTabInsertion: dragSplit.hoveredTabInsertion,
          setDragRootNode: dragSplit.setDragRootNode
        })}
        {/* Why: the sortable tab is anchored inside its source tab strip (no
          transform while dragging), and that strip uses overflow-hidden so
          the tab is invisible once the cursor leaves it. DragOverlay
          renders a ghost in a document-level portal that tracks the cursor
          across the whole window — the source tab keeps its spot, the
          ghost follows the cursor. */}
        <DragOverlay dropAnimation={null}>
          {dragSplit.activeDrag ? <TabDragPreview drag={dragSplit.activeDrag} /> : null}
        </DragOverlay>
        {dragSplit.hoveredDropTarget &&
        dragSplit.hoveredDropTarget.zone !== 'center' &&
        dragSplit.hoveredDropTarget.panelRect ? (
          <TabPaneColumnSplitDragOverlay
            panelRect={dragSplit.hoveredDropTarget.panelRect}
            zone={dragSplit.hoveredDropTarget.zone}
          />
        ) : null}
      </DndContext>
    </TabDragProvider>
  )
}
