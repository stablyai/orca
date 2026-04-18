import { useCallback, useState } from 'react';
import { ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, requestEditorSaveQuiesce } from '@/components/editor/editor-autosave';
export function useTerminalSaveDialog({ openFiles, closeFile, markFileDirty }) {
    const [saveDialogFileId, setSaveDialogFileId] = useState(null);
    const saveDialogFile = saveDialogFileId
        ? (openFiles.find((f) => f.id === saveDialogFileId) ?? null)
        : null;
    const requestCloseFile = useCallback((fileId) => {
        const file = openFiles.find((openFile) => openFile.id === fileId);
        if (file?.isDirty) {
            setSaveDialogFileId(fileId);
            return;
        }
        closeFile(fileId);
    }, [closeFile, openFiles]);
    const handleSaveDialogSave = useCallback(() => {
        if (!saveDialogFileId) {
            return;
        }
        window.dispatchEvent(new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail: { fileId: saveDialogFileId } }));
        setSaveDialogFileId(null);
    }, [saveDialogFileId]);
    const handleSaveDialogDiscard = useCallback(async () => {
        if (!saveDialogFileId) {
            return;
        }
        // Why: "Don't Save" must win over any pending autosave write for the same
        // tab, even if the editor is currently waiting on a background debounce.
        await requestEditorSaveQuiesce({ fileId: saveDialogFileId });
        markFileDirty(saveDialogFileId, false);
        closeFile(saveDialogFileId);
        setSaveDialogFileId(null);
    }, [closeFile, markFileDirty, saveDialogFileId]);
    const handleSaveDialogCancel = useCallback(() => {
        setSaveDialogFileId(null);
    }, []);
    return {
        saveDialogFileId,
        saveDialogFile,
        requestCloseFile,
        handleSaveDialogSave,
        handleSaveDialogDiscard,
        handleSaveDialogCancel
    };
}
