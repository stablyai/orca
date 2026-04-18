import type { OpenFile } from '@/store/slices/editor';
import type { GitBranchChangeEntry, GitStatusEntry } from '../../../../shared/types';
export type EditorHeaderCopyState = {
    copyText: string | null;
    copyToastLabel: string;
    pathLabel: string;
    pathTitle: string;
};
export type EditorHeaderOpenFileState = {
    canOpen: boolean;
};
export declare function getEditorHeaderCopyState(file: OpenFile): EditorHeaderCopyState;
export declare function getEditorHeaderOpenFileState(file: OpenFile, worktreeEntry?: GitStatusEntry | null, branchEntry?: GitBranchChangeEntry | null): EditorHeaderOpenFileState;
