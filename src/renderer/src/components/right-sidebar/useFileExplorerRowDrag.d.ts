import React from 'react';
type UseFileExplorerRowDragParams = {
    rowDropDir: string;
    isDirectory: boolean;
    nodePath: string;
    isExpanded: boolean;
    onDragTargetChange: (dir: string | null) => void;
    onDragExpandDir: (dirPath: string) => void;
    onNativeDragTargetChange: (dir: string | null) => void;
    onNativeDragExpandDir: (dirPath: string) => void;
    onMoveDrop: (sourcePath: string, destDir: string) => void;
};
type RowDragHandlers = {
    handleDragOver: (e: React.DragEvent) => void;
    handleDragEnter: (e: React.DragEvent) => void;
    handleDragLeave: (e: React.DragEvent) => void;
    handleDrop: (e: React.DragEvent) => void;
};
export declare function useFileExplorerRowDrag({ rowDropDir, isDirectory, nodePath, isExpanded, onDragTargetChange, onDragExpandDir, onNativeDragTargetChange, onNativeDragExpandDir, onMoveDrop }: UseFileExplorerRowDragParams): RowDragHandlers;
export {};
