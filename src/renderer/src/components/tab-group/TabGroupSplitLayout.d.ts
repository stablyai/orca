import type { TabGroupLayoutNode } from '../../../../shared/types';
export default function TabGroupSplitLayout({ layout, worktreeId, focusedGroupId, isWorktreeActive }: {
    layout: TabGroupLayoutNode;
    worktreeId: string;
    focusedGroupId?: string;
    isWorktreeActive: boolean;
}): React.JSX.Element;
