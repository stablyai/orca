import { type CollisionDetection, type DragEndEvent, type DragMoveEvent, type DragOverEvent, type DragStartEvent, type UniqueIdentifier, useSensors } from '@dnd-kit/core';
import type { TabGroup } from '../../../../shared/types';
import type { TabSplitDirection } from '../../store/slices/tabs';
export type TabDropZone = 'center' | TabSplitDirection;
export type TabDragItemData = {
    kind: 'tab';
    worktreeId: string;
    groupId: string;
    unifiedTabId: string;
    visibleTabId: string;
    tabType: 'terminal' | 'editor' | 'browser';
};
export type TabPaneDropData = {
    kind: 'pane-body';
    worktreeId: string;
    groupId: string;
};
export type HoveredTabDropTarget = {
    groupId: string;
    zone: TabDropZone;
};
export declare function canDropTabIntoPaneBody({ activeDrag, groupsByWorktree, overGroupId, worktreeId }: {
    activeDrag: TabDragItemData | null;
    groupsByWorktree: Record<string, TabGroup[]>;
    overGroupId: string;
    worktreeId: string;
}): boolean;
export declare function getTabPaneBodyDroppableId(groupId: string): UniqueIdentifier;
export declare function useTabDragSplit({ worktreeId, enabled }: {
    worktreeId: string;
    /** When false (e.g. for hidden worktrees), returns empty sensors so no
     *  DndContext pointer listeners are registered on the document. Multiple
     *  simultaneous DndContext instances with active sensors can interfere. */
    enabled?: boolean;
}): {
    activeDrag: TabDragItemData | null;
    collisionDetection: CollisionDetection;
    hoveredDropTarget: HoveredTabDropTarget | null;
    onDragCancel: () => void;
    onDragEnd: (event: DragEndEvent) => void;
    onDragMove: (event: DragMoveEvent) => void;
    onDragOver: (event: DragOverEvent) => void;
    onDragStart: (event: DragStartEvent) => void;
    sensors: ReturnType<typeof useSensors>;
};
