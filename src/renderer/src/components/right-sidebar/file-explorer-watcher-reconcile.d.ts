import type { Dispatch, SetStateAction } from 'react';
import type { DirCache } from './file-explorer-types';
export declare function purgeDirCacheSubtree(setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>, deletedPath: string): void;
export declare function purgeExpandedDirsSubtree(worktreeId: string, deletedPath: string): void;
export declare function clearStalePendingReveal(deletedPath: string): void;
