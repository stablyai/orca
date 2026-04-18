type ExplorerOp = {
    undo: () => Promise<void>;
    redo: () => Promise<void>;
};
export declare function commitFileExplorerOp(op: ExplorerOp): void;
export declare function clearFileExplorerUndoHistory(): void;
export declare function undoFileExplorer(): Promise<boolean>;
export declare function redoFileExplorer(): Promise<boolean>;
export declare function fileExplorerHasUndo(): boolean;
export declare function fileExplorerHasRedo(): boolean;
export {};
