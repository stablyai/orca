const pendingEditorFlushes = new Map();
export function registerPendingEditorFlush(fileId, flush) {
    pendingEditorFlushes.set(fileId, flush);
    return () => {
        if (pendingEditorFlushes.get(fileId) === flush) {
            pendingEditorFlushes.delete(fileId);
        }
    };
}
export function flushPendingEditorChange(fileId) {
    pendingEditorFlushes.get(fileId)?.();
}
