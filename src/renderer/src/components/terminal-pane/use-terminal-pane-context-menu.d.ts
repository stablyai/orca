import type { PaneManager } from '@/lib/pane-manager/pane-manager';
type UseTerminalPaneContextMenuDeps = {
    managerRef: React.RefObject<PaneManager | null>;
    toggleExpandPane: (paneId: number) => void;
    onRequestClosePane: (paneId: number) => void;
    onSetTitle: (paneId: number) => void;
    rightClickToPaste: boolean;
};
type TerminalMenuState = {
    open: boolean;
    setOpen: React.Dispatch<React.SetStateAction<boolean>>;
    point: {
        x: number;
        y: number;
    };
    menuOpenedAtRef: React.RefObject<number>;
    paneCount: number;
    menuPaneId: number | null;
    onContextMenuCapture: (event: React.MouseEvent<HTMLDivElement>) => void;
    onCopy: () => Promise<void>;
    onPaste: () => Promise<void>;
    onSplitRight: () => void;
    onSplitDown: () => void;
    onClosePane: () => void;
    onClearScreen: () => void;
    onToggleExpand: () => void;
    onSetTitle: () => void;
};
export declare function useTerminalPaneContextMenu({ managerRef, toggleExpandPane, onRequestClosePane, onSetTitle, rightClickToPaste }: UseTerminalPaneContextMenuDeps): TerminalMenuState;
export {};
