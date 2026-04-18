import type { OpenFile } from '@/store/slices/editor';
type UseTerminalSaveDialogParams = {
    openFiles: OpenFile[];
    closeFile: (fileId: string) => void;
    markFileDirty: (fileId: string, dirty: boolean) => void;
};
type UseTerminalSaveDialogResult = {
    saveDialogFileId: string | null;
    saveDialogFile: OpenFile | null;
    requestCloseFile: (fileId: string) => void;
    handleSaveDialogSave: () => void;
    handleSaveDialogDiscard: () => void;
    handleSaveDialogCancel: () => void;
};
export declare function useTerminalSaveDialog({ openFiles, closeFile, markFileDirty }: UseTerminalSaveDialogParams): UseTerminalSaveDialogResult;
export {};
