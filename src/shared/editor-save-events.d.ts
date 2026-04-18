export declare const ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT = "orca:editor-save-dirty-files";
export type EditorSaveDirtyFilesDetail = {
    claim: () => void;
    resolve: () => void;
    reject: (message: string) => void;
};
