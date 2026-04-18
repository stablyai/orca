import React from 'react';
export declare function FileExplorerBackgroundMenu({ open, onOpenChange, point, worktreePath, onStartNew }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    point: {
        x: number;
        y: number;
    };
    worktreePath: string;
    onStartNew: (type: 'file' | 'folder', dir: string, depth: number) => void;
}): React.JSX.Element;
