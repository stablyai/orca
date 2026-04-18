import type { BrowserTab as BrowserTabState } from '../../../../shared/types';
import type { TabDragItemData } from '../tab-group/useTabDragSplit';
export default function BrowserTab({ tab, isActive, hasTabsToRight, onActivate, onClose, onCloseToRight, onSplitGroup, dragData }: {
    tab: BrowserTabState;
    isActive: boolean;
    hasTabsToRight: boolean;
    onActivate: () => void;
    onClose: () => void;
    onCloseToRight: () => void;
    onSplitGroup: (direction: 'left' | 'right' | 'up' | 'down', sourceVisibleTabId: string) => void;
    dragData: TabDragItemData;
}): React.JSX.Element;
