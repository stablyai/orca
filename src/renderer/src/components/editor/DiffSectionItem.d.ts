import React, { type MutableRefObject } from 'react';
import type { editor as monacoEditor } from 'monaco-editor';
import type { GitDiffResult } from '../../../../shared/types';
type DiffSection = {
    key: string;
    path: string;
    status: string;
    area?: 'staged' | 'unstaged' | 'untracked';
    oldPath?: string;
    originalContent: string;
    modifiedContent: string;
    collapsed: boolean;
    loading: boolean;
    dirty: boolean;
    diffResult: GitDiffResult | null;
};
export declare function DiffSectionItem({ section, index, isBranchMode, sideBySide, isDark, settings, sectionHeight, worktreeId, worktreeRoot, loadSection, toggleSection, setSectionHeights, setSections, modifiedEditorsRef, handleSectionSaveRef }: {
    section: DiffSection;
    index: number;
    isBranchMode: boolean;
    sideBySide: boolean;
    isDark: boolean;
    settings: {
        terminalFontSize?: number;
        terminalFontFamily?: string;
    } | null;
    sectionHeight: number | undefined;
    worktreeId: string;
    /** The worktree root directory — not a file path; used to resolve absolute paths for opening files. */
    worktreeRoot: string;
    loadSection: (index: number) => void;
    toggleSection: (index: number) => void;
    setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>;
    setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>;
    modifiedEditorsRef: MutableRefObject<Map<number, monacoEditor.IStandaloneCodeEditor>>;
    handleSectionSaveRef: MutableRefObject<(index: number) => Promise<void>>;
}): React.JSX.Element;
export {};
