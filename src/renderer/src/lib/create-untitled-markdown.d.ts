/**
 * Creates an untitled markdown file on disk and returns the metadata
 * needed by the editor store's `openFile` action.
 *
 * Throws on permission errors or name-collision exhaustion so callers
 * can surface the failure instead of silently dropping it.
 */
export declare function createUntitledMarkdownFile(worktreePath: string, worktreeId: string): Promise<{
    filePath: string;
    relativePath: string;
    worktreeId: string;
    language: string;
    isUntitled: true;
    mode: 'edit';
}>;
