import type { Dispatch, SetStateAction } from 'react';
import type { DirCache } from './file-explorer-types';
import type { InlineInput } from './FileExplorerRow';
type UseFileExplorerWatchParams = {
    worktreePath: string | null;
    activeWorktreeId: string | null;
    dirCache: Record<string, DirCache>;
    setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>;
    expanded: Set<string>;
    setSelectedPath: Dispatch<SetStateAction<string | null>>;
    refreshDir: (dirPath: string) => Promise<void>;
    refreshTree: () => Promise<void>;
    inlineInput: InlineInput | null;
    dragSourcePath: string | null;
};
/**
 * Subscribes to filesystem watcher events for the active worktree and
 * reconciles File Explorer state on external changes.
 *
 * Why: the renderer must explicitly tell main which worktree to watch
 * because activeWorktreeId is renderer-local Zustand state (design §4.2).
 */
export declare function useFileExplorerWatch({ worktreePath, activeWorktreeId, dirCache, setDirCache, expanded, setSelectedPath, refreshDir, refreshTree, inlineInput, dragSourcePath }: UseFileExplorerWatchParams): void;
export {};
