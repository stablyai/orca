export type ParsedTerminalFileLink = {
    pathText: string;
    line: number | null;
    column: number | null;
    startIndex: number;
    endIndex: number;
    displayText: string;
};
export type ResolvedTerminalFileLink = {
    absolutePath: string;
    line: number | null;
    column: number | null;
};
export declare function extractTerminalFileLinks(lineText: string): ParsedTerminalFileLink[];
export declare function resolveTerminalFileLink(parsed: ParsedTerminalFileLink, cwd: string): ResolvedTerminalFileLink | null;
export declare function isPathInsideWorktree(filePath: string, worktreePath: string): boolean;
export declare function toWorktreeRelativePath(filePath: string, worktreePath: string): string | null;
