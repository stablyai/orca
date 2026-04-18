import type { OpenFile } from '@/store/slices/editor';
export declare const ORCA_EDITOR_QUIESCE_FILE_SAVES_EVENT = "orca:editor-quiesce-file-saves";
export declare const ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT = "orca:editor-external-file-change";
export declare const ORCA_EDITOR_SAVE_FILE_EVENT = "orca:editor-save-file";
export declare const ORCA_EDITOR_SAVE_AND_CLOSE_EVENT = "orca:save-and-close";
export declare const ORCA_EDITOR_FILE_SAVED_EVENT = "orca:editor-file-saved";
export declare const ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT = "orca:editor-request-cmd-save";
export type EditorPathMutationTarget = {
    worktreeId: string;
    worktreePath: string;
    relativePath: string;
};
export type EditorSaveQuiesceTarget = {
    fileId: string;
} | EditorPathMutationTarget;
export type EditorSaveQuiesceDetail = EditorSaveQuiesceTarget & {
    claim: () => void;
    resolve: () => void;
};
export type EditorSaveFileTarget = {
    fileId: string;
    fallbackContent?: string;
};
export type EditorSaveFileDetail = EditorSaveFileTarget & {
    claim: () => void;
    resolve: () => void;
    reject: (message: string) => void;
};
export type EditorFileSavedDetail = {
    fileId: string;
    content: string;
};
export declare function canAutoSaveOpenFile(file: OpenFile): boolean;
export declare function normalizeAutoSaveDelayMs(value: unknown): number;
export declare function getOpenFilesForExternalFileChange(openFiles: OpenFile[], target: EditorPathMutationTarget): OpenFile[];
export declare function requestEditorSaveQuiesce(target: EditorSaveQuiesceTarget): Promise<void>;
export declare function requestEditorFileSave(target: EditorSaveFileTarget): Promise<void>;
export declare function notifyEditorExternalFileChange(target: EditorPathMutationTarget): void;
