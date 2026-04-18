import { describe, expect, it } from 'vitest';
import { getEditorHeaderCopyState, getEditorHeaderOpenFileState } from './editor-header';
function makeOpenFile(overrides = {}) {
    return {
        id: '/repo/file.ts',
        filePath: '/repo/file.ts',
        relativePath: 'file.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        isDirty: false,
        mode: 'edit',
        ...overrides
    };
}
describe('getEditorHeaderCopyState', () => {
    it('shows the absolute file path for normal file tabs', () => {
        expect(getEditorHeaderCopyState(makeOpenFile())).toEqual({
            copyText: '/repo/file.ts',
            copyToastLabel: 'File path copied',
            pathLabel: '/repo/file.ts',
            pathTitle: '/repo/file.ts'
        });
    });
    it('adds a diff suffix to single-file diff headers', () => {
        expect(getEditorHeaderCopyState(makeOpenFile({
            id: '/repo/file.ts::unstaged',
            mode: 'diff',
            diffSource: 'unstaged'
        }))).toEqual({
            copyText: '/repo/file.ts',
            copyToastLabel: 'File path copied',
            pathLabel: '/repo/file.ts (diff)',
            pathTitle: '/repo/file.ts (diff)'
        });
    });
    it('adds a staged diff suffix to staged diff headers', () => {
        expect(getEditorHeaderCopyState(makeOpenFile({
            id: '/repo/file.ts::staged',
            mode: 'diff',
            diffSource: 'staged'
        }))).toEqual({
            copyText: '/repo/file.ts',
            copyToastLabel: 'File path copied',
            pathLabel: '/repo/file.ts (staged diff)',
            pathTitle: '/repo/file.ts (staged diff)'
        });
    });
    it('shows All Changes while still copying the worktree path', () => {
        expect(getEditorHeaderCopyState(makeOpenFile({
            id: 'wt-1::all-diffs::uncommitted',
            filePath: '/repo/worktree',
            relativePath: 'All Changes',
            mode: 'diff',
            diffSource: 'combined-uncommitted'
        }))).toEqual({
            copyText: '/repo/worktree',
            copyToastLabel: 'Worktree path copied',
            pathLabel: 'All Changes',
            pathTitle: '/repo/worktree'
        });
    });
});
describe('getEditorHeaderOpenFileState', () => {
    it('allows opening the file from a normal unstaged diff', () => {
        expect(getEditorHeaderOpenFileState(makeOpenFile({
            id: 'wt-1::diff::unstaged::file.ts',
            mode: 'diff',
            diffSource: 'unstaged'
        }), { path: 'file.ts', status: 'modified', area: 'unstaged' })).toEqual({ canOpen: true });
    });
    it('disables opening the file when the uncommitted diff is deleted', () => {
        expect(getEditorHeaderOpenFileState(makeOpenFile({
            id: 'wt-1::diff::unstaged::file.ts',
            mode: 'diff',
            diffSource: 'unstaged'
        }), { path: 'file.ts', status: 'deleted', area: 'unstaged' })).toEqual({ canOpen: false });
    });
    it('disables opening the file when the branch diff target is deleted', () => {
        expect(getEditorHeaderOpenFileState(makeOpenFile({
            id: 'wt-1::diff::branch::main::v1::file.ts',
            mode: 'diff',
            diffSource: 'branch'
        }), null, { path: 'file.ts', status: 'deleted' })).toEqual({ canOpen: false });
    });
    it('keeps branch diff open enabled when the live compare entry is gone', () => {
        expect(getEditorHeaderOpenFileState(makeOpenFile({
            id: 'wt-1::diff::branch::main::v1::file.ts',
            mode: 'diff',
            diffSource: 'branch'
        }), null, null)).toEqual({ canOpen: true });
    });
    it('keeps the action enabled when live uncommitted metadata has already disappeared', () => {
        expect(getEditorHeaderOpenFileState(makeOpenFile({
            id: 'wt-1::diff::unstaged::file.ts',
            mode: 'diff',
            diffSource: 'unstaged'
        }), null)).toEqual({ canOpen: true });
    });
});
