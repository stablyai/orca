type TerminalContextMenuProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    menuPoint: {
        x: number;
        y: number;
    };
    menuOpenedAtRef: React.RefObject<number>;
    canClosePane: boolean;
    canExpandPane: boolean;
    menuPaneIsExpanded: boolean;
    onCopy: () => void;
    onPaste: () => void;
    onSplitRight: () => void;
    onSplitDown: () => void;
    onClosePane: () => void;
    onClearScreen: () => void;
    onToggleExpand: () => void;
    onSetTitle: () => void;
};
export default function TerminalContextMenu({ open, onOpenChange, menuPoint, menuOpenedAtRef, canClosePane, canExpandPane, menuPaneIsExpanded, onCopy, onPaste, onSplitRight, onSplitDown, onClosePane, onClearScreen, onToggleExpand, onSetTitle }: TerminalContextMenuProps): React.JSX.Element;
export {};
