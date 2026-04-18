import { joinPath } from '@/lib/path';
import { DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS, MAX_EDITOR_AUTO_SAVE_DELAY_MS, MIN_EDITOR_AUTO_SAVE_DELAY_MS } from '../../../../shared/constants';
import { clampNumber } from '@/lib/terminal-theme';
export const ORCA_EDITOR_QUIESCE_FILE_SAVES_EVENT = 'orca:editor-quiesce-file-saves';
export const ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT = 'orca:editor-external-file-change';
export const ORCA_EDITOR_SAVE_FILE_EVENT = 'orca:editor-save-file';
export const ORCA_EDITOR_SAVE_AND_CLOSE_EVENT = 'orca:save-and-close';
export const ORCA_EDITOR_FILE_SAVED_EVENT = 'orca:editor-file-saved';
export const ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT = 'orca:editor-request-cmd-save';
export function canAutoSaveOpenFile(file) {
    // Why: single-file editors and one-file unstaged diffs have an unambiguous
    // write target. Combined diff and conflict-review tabs can represent multiple
    // paths, so autosave must stay out of those surfaces until they have their
    // own save coordination instead of guessing which file should be written.
    return file.mode === 'edit' || (file.mode === 'diff' && file.diffSource === 'unstaged');
}
export function normalizeAutoSaveDelayMs(value) {
    // Why: settings are persisted locally and can be missing or hand-edited.
    // Clamp the delay at the write site so autosave never degenerates into an
    // effectively immediate save loop or an unexpectedly huge wait.
    const numericValue = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : null;
    const normalizedValue = numericValue !== null && Number.isFinite(numericValue)
        ? numericValue
        : DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS;
    return clampNumber(normalizedValue, MIN_EDITOR_AUTO_SAVE_DELAY_MS, MAX_EDITOR_AUTO_SAVE_DELAY_MS);
}
export function getOpenFilesForExternalFileChange(openFiles, target) {
    const absolutePath = joinPath(target.worktreePath, target.relativePath);
    return openFiles.filter((file) => {
        if (file.worktreeId !== target.worktreeId) {
            return false;
        }
        if (file.mode === 'edit') {
            return file.filePath === absolutePath;
        }
        if (file.mode === 'diff') {
            return file.diffSource === 'unstaged' && file.relativePath === target.relativePath;
        }
        return false;
    });
}
export async function requestEditorSaveQuiesce(target) {
    await new Promise((resolve) => {
        let claimed = false;
        window.dispatchEvent(new CustomEvent(ORCA_EDITOR_QUIESCE_FILE_SAVES_EVENT, {
            detail: {
                ...target,
                claim: () => {
                    claimed = true;
                },
                resolve
            }
        }));
        // Why: discard/delete flows also run when no editor tab is mounted. Let
        // those external mutations proceed immediately instead of hanging forever
        // waiting on a quiesce listener that does not exist in that UI state.
        if (!claimed) {
            resolve();
        }
    });
}
export async function requestEditorFileSave(target) {
    await new Promise((resolve, reject) => {
        let claimed = false;
        window.dispatchEvent(new CustomEvent(ORCA_EDITOR_SAVE_FILE_EVENT, {
            detail: {
                ...target,
                claim: () => {
                    claimed = true;
                },
                resolve,
                reject: (message) => reject(new Error(message))
            }
        }));
        // Why: a direct save request should never report success unless some
        // controller actually accepted responsibility for writing the file. Unlike
        // quiesce, silently no-oping here would make Cmd/Ctrl+S look successful
        // while dropping the user's save entirely.
        if (!claimed) {
            reject(new Error('Editor save controller is unavailable.'));
        }
    });
}
export function notifyEditorExternalFileChange(target) {
    window.dispatchEvent(new CustomEvent(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, {
        detail: target
    }));
}
