import type { GitFileStatus } from '../../../../shared/types';
import type { OpenFile } from '../../store/slices/editor';
import type { TabDragItemData } from '../tab-group/useTabDragSplit';
export default function EditorFileTab({ file, isActive, hasTabsToRight, statusByRelativePath, onActivate, onClose, onCloseToRight, onCloseAll, onPin, onSplitGroup, dragData }: {
    file: OpenFile & {
        tabId?: string;
    };
    isActive: boolean;
    hasTabsToRight: boolean;
    statusByRelativePath: Map<string, GitFileStatus>;
    onActivate: () => void;
    onClose: () => void;
    onCloseToRight: () => void;
    onCloseAll: () => void;
    onPin?: () => void;
    onSplitGroup: (direction: 'left' | 'right' | 'up' | 'down', sourceVisibleTabId: string) => void;
    dragData: TabDragItemData;
}): React.JSX.Element;
