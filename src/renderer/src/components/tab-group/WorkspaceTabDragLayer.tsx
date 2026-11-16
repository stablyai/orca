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

/** Share one drag scope across workspace strips and pane bodies so duplicate DndContexts cannot compete for the same tabs. */
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
        // Disable edge autoscroll because moving tabs re-resolve hover targets and create a multi-group feedback loop.
        autoScroll={false}
      >
        {children({
          isTabDragActive: dragSplit.activeDrag !== null,
          hoveredTabInsertion: dragSplit.hoveredTabInsertion,
          setDragRootNode: dragSplit.setDragRootNode
        })}
        {/* Keep the source tab anchored while a portal ghost follows the cursor beyond the clipped strip. */}
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
