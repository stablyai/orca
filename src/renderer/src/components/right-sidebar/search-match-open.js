import { detectLanguage } from '@/lib/language-detect';
export function cancelRevealFrame(frameRef) {
    if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
    }
}
export function openMatchResult(params) {
    const { activeWorktreeId, fileResult, match, openFile, setPendingEditorReveal, revealRafRef, revealInnerRafRef } = params;
    openFile({
        filePath: fileResult.filePath,
        relativePath: fileResult.relativePath,
        worktreeId: activeWorktreeId,
        language: detectLanguage(fileResult.relativePath),
        mode: 'edit'
    });
    cancelRevealFrame(revealRafRef);
    cancelRevealFrame(revealInnerRafRef);
    setPendingEditorReveal(null);
    // Why: opening a result can replace the active tab and mount Monaco
    // asynchronously. Matching terminal-link navigation, wait two frames so
    // the destination editor owns focus/layout before we ask it to reveal.
    revealRafRef.current = requestAnimationFrame(() => {
        revealInnerRafRef.current = requestAnimationFrame(() => {
            setPendingEditorReveal({
                filePath: fileResult.filePath,
                line: match.line,
                column: match.column,
                matchLength: match.matchLength
            });
            cancelRevealFrame(revealRafRef);
            cancelRevealFrame(revealInnerRafRef);
        });
    });
}
