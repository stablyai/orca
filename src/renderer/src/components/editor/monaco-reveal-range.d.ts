export type MonacoRevealRange = {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
};
export declare function computeMonacoRevealRange(params: {
    line: number;
    column: number;
    matchLength: number;
    maxLine: number;
    lineMaxColumn: number;
}): MonacoRevealRange;
