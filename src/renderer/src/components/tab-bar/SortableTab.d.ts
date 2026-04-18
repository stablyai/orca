import type { TerminalTab } from '../../../../shared/types';
import type { TabDragItemData } from '../tab-group/useTabDragSplit';
type SortableTabProps = {
    tab: TerminalTab;
    tabCount: number;
    hasTabsToRight: boolean;
    isActive: boolean;
    isExpanded: boolean;
    onActivate: (tabId: string) => void;
    onClose: (tabId: string) => void;
    onCloseOthers: (tabId: string) => void;
    onCloseToRight: (tabId: string) => void;
    onSetCustomTitle: (tabId: string, title: string | null) => void;
    onSetTabColor: (tabId: string, color: string | null) => void;
    onToggleExpand: (tabId: string) => void;
    onSplitGroup: (direction: 'left' | 'right' | 'up' | 'down', sourceVisibleTabId: string) => void;
    dragData: TabDragItemData;
};
export declare const TAB_COLORS: ({
    label: string;
    value: null;
} | {
    label: string;
    value: string;
})[];
export declare const CLOSE_ALL_CONTEXT_MENUS_EVENT = "orca-close-all-context-menus";
export default function SortableTab({ tab, tabCount, hasTabsToRight, isActive, isExpanded, onActivate, onClose, onCloseOthers, onCloseToRight, onSetCustomTitle, onSetTabColor, onToggleExpand, onSplitGroup, dragData }: SortableTabProps): React.JSX.Element;
export {};
