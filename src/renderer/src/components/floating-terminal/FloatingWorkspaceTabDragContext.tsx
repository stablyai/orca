import { cloneElement } from 'react'
import { DndContext, DragOverlay } from '@dnd-kit/core'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import TabDragPreview from '../tab-bar/TabDragPreview'
import { TabDragProvider } from '../tab-group/tab-drag-context'
import { useTabDragSplit, type HoveredTabInsertion } from '../tab-group/useTabDragSplit'

/** dnd-kit host for the floating workspace tab strip, so its tabs reorder with
 *  the same gesture and insertion bar the main workspace tab bar uses. The panel
 *  renders one group and no split layout, so a drop only ever resolves to a
 *  same-group reorder — the pane-column split branches find no panel geometry. */
export function FloatingWorkspaceTabDragContext({
  enabled,
  children
}: {
  /** False while the panel is hidden: a closed panel must not register sensors that compete with the workspace DndContext. */
  enabled: boolean
  children: React.ReactElement<{ hoveredTabInsertion?: HoveredTabInsertion | null }>
}): React.JSX.Element {
  const dragSplit = useTabDragSplit({ worktreeId: FLOATING_TERMINAL_WORKTREE_ID, enabled })

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
        // Why: same feedback loop the workspace strip hits — autoscroll shifts tabs under a still cursor and `over` re-resolves.
        autoScroll={false}
      >
        <div ref={dragSplit.setDragRootNode} className="flex h-full min-w-0 flex-1">
          {/* Why cloneElement over a render prop: the tab bar stays a plain child element, which keeps the panel's tree shallow-walkable. */}
          {cloneElement(children, { hoveredTabInsertion: dragSplit.hoveredTabInsertion })}
        </div>
        {/* Why: the source tab stays anchored in the overflow-hidden strip; this ghost is what follows the cursor. */}
        <DragOverlay dropAnimation={null}>
          {dragSplit.activeDrag ? <TabDragPreview drag={dragSplit.activeDrag} /> : null}
        </DragOverlay>
      </DndContext>
    </TabDragProvider>
  )
}
