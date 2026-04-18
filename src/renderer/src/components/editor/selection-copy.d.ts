import type { IRange } from 'monaco-editor';
type FormatCopiedSelectionArgs = {
    relativePath: string;
    language: string;
    selection: IRange;
    selectedText: string;
};
export declare function formatCopiedSelectionWithContext({ relativePath, language, selection, selectedText }: FormatCopiedSelectionArgs): string | null;
export declare function getContextualCopyLineRange(selection: IRange): {
    startLine: number;
    endLine: number;
};
export declare function getInclusiveEndLine(selection: IRange): number;
export {};
