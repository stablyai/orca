import { type TabDropZone } from './useTabDragSplit';
export default function TabGroupPanel({ groupId, worktreeId, isFocused, hasSplitGroups, reserveClosedExplorerToggleSpace, reserveCollapsedSidebarHeaderSpace, isTabDragActive, activeDropZone }: {
    groupId: string;
    worktreeId: string;
    isFocused: boolean;
    hasSplitGroups: boolean;
    reserveClosedExplorerToggleSpace: boolean;
    reserveCollapsedSidebarHeaderSpace: boolean;
    isTabDragActive?: boolean;
    activeDropZone?: TabDropZone | null;
}): React.JSX.Element;
