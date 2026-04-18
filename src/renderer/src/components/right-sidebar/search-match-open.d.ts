import type { SearchFileResult, SearchMatch } from '../../../../shared/types';
export declare function cancelRevealFrame(frameRef: React.RefObject<number | null>): void;
export declare function openMatchResult(params: {
    activeWorktreeId: string;
    fileResult: SearchFileResult;
    match: SearchMatch;
    openFile: (file: {
        filePath: string;
        relativePath: string;
        worktreeId: string;
        language: string;
        mode: 'edit';
    }) => void;
    setPendingEditorReveal: (reveal: {
        filePath: string;
        line: number;
        column: number;
        matchLength: number;
    } | null) => void;
    revealRafRef: React.RefObject<number | null>;
    revealInnerRafRef: React.RefObject<number | null>;
}): void;
