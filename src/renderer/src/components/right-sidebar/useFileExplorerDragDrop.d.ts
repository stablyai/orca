import type { RefObject } from 'react';
type UseFileExplorerDragDropParams = {
    worktreePath: string | null;
    activeWorktreeId: string | null;
    expanded: Set<string>;
    toggleDir: (worktreeId: string, dirPath: string) => void;
    refreshDir: (dirPath: string) => Promise<void>;
    scrollRef: RefObject<HTMLDivElement | null>;
};
type UseFileExplorerDragDropResult = {
    handleMoveDrop: (sourcePath: string, destDir: string) => void;
    handleDragExpandDir: (dirPath: string) => void;
    dropTargetDir: string | null;
    setDropTargetDir: (dir: string | null) => void;
    dragSourcePath: string | null;
    setDragSourcePath: (path: string | null) => void;
    isRootDragOver: boolean;
    /** True when a native OS file drag (Files) is hovering over the explorer */
    isNativeDragOver: boolean;
    /** Directory path highlighted during a native Files drag, or null */
    nativeDropTargetDir: string | null;
    setNativeDropTargetDir: (dir: string | null) => void;
    handleNativeDragExpandDir: (dirPath: string) => void;
    stopDragEdgeScroll: () => void;
    rootDragHandlers: {
        onDragOver: (e: React.DragEvent) => void;
        onDragEnter: (e: React.DragEvent) => void;
        onDragLeave: (e: React.DragEvent) => void;
        onDrop: (e: React.DragEvent) => void;
    };
    /** Clears all native drag visual state (call after import completes) */
    clearNativeDragState: () => void;
};
export declare function useFileExplorerDragDrop({ worktreePath, activeWorktreeId, expanded, toggleDir, refreshDir, scrollRef }: UseFileExplorerDragDropParams): UseFileExplorerDragDropResult;
export {};
