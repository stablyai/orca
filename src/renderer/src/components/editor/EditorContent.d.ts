import React from 'react';
import type { OpenFile } from '@/store/slices/editor';
import type { GitStatusEntry, GitDiffResult } from '../../../../shared/types';
type FileContent = {
    content: string;
    isBinary: boolean;
    isImage?: boolean;
    mimeType?: string;
};
type MarkdownViewMode = 'source' | 'rich';
export declare function EditorContent({ activeFile, viewStateScopeId, fileContents, diffContents, editBuffers, worktreeEntries, resolvedLanguage, isMarkdown, isMermaid, mdViewMode, sideBySide, pendingEditorReveal, handleContentChange, handleDirtyStateHint, handleSave }: {
    activeFile: OpenFile;
    viewStateScopeId: string;
    fileContents: Record<string, FileContent>;
    diffContents: Record<string, GitDiffResult>;
    editBuffers: Record<string, string>;
    worktreeEntries: GitStatusEntry[];
    resolvedLanguage: string;
    isMarkdown: boolean;
    isMermaid: boolean;
    mdViewMode: MarkdownViewMode;
    sideBySide: boolean;
    pendingEditorReveal: {
        filePath?: string;
        line?: number;
        column?: number;
        matchLength?: number;
    } | null;
    handleContentChange: (content: string) => void;
    handleDirtyStateHint: (dirty: boolean) => void;
    handleSave: (content: string) => Promise<void>;
}): React.JSX.Element;
export {};
