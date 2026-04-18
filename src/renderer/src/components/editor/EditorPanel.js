import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/* eslint-disable max-lines -- Why: EditorPanel still owns the visible editor
save/load/render lifecycle for many modes (edit, diff, conflict review), and
keeping that UI state together is easier to reason about than scattering it
across multiple components. Autosave now lives in a smaller headless controller
so hidden editor UI no longer participates in shutdown. */
import React, { useCallback, useEffect, useRef, useState, Suspense } from 'react';
import * as monaco from 'monaco-editor';
import { Columns2, Copy, ExternalLink, FileText, Rows2 } from 'lucide-react';
import { useAppStore } from '@/store';
import { findWorktreeById } from '@/store/slices/worktree-helpers';
import { getConnectionId } from '@/lib/connection-context';
import { detectLanguage } from '@/lib/language-detect';
import { getEditorHeaderCopyState, getEditorHeaderOpenFileState } from './editor-header';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '../tab-bar/SortableTab';
import MarkdownViewToggle from './MarkdownViewToggle';
import { EditorContent } from './EditorContent';
import { scrollTopCache, cursorPositionCache, diffViewStateCache } from '@/lib/scroll-cache';
import { getOpenFilesForExternalFileChange, ORCA_EDITOR_FILE_SAVED_EVENT, ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, requestEditorFileSave, requestEditorSaveQuiesce, ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT } from './editor-autosave';
import { UntitledFileRenameDialog } from './UntitledFileRenameDialog';
const isMac = navigator.userAgent.includes('Mac');
const isLinux = navigator.userAgent.includes('Linux');
/** Platform-appropriate label: macOS → Finder, Windows → File Explorer, Linux → Files */
const revealLabel = isMac
    ? 'Reveal in Finder'
    : isLinux
        ? 'Open Containing Folder'
        : 'Reveal in File Explorer';
function EditorPanelInner({ activeFileId: activeFileIdProp, activeViewStateId: activeViewStateIdProp } = {}) {
    const openFiles = useAppStore((s) => s.openFiles);
    const globalActiveFileId = useAppStore((s) => s.activeFileId);
    const activeFileId = activeFileIdProp ?? globalActiveFileId;
    const markFileDirty = useAppStore((s) => s.markFileDirty);
    const pendingEditorReveal = useAppStore((s) => s.pendingEditorReveal);
    const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree);
    const gitBranchChangesByWorktree = useAppStore((s) => s.gitBranchChangesByWorktree);
    const markdownViewMode = useAppStore((s) => s.markdownViewMode);
    const setMarkdownViewMode = useAppStore((s) => s.setMarkdownViewMode);
    const openFile = useAppStore((s) => s.openFile);
    const closeFile = useAppStore((s) => s.closeFile);
    const clearUntitled = useAppStore((s) => s.clearUntitled);
    const editorDrafts = useAppStore((s) => s.editorDrafts);
    const setEditorDraft = useAppStore((s) => s.setEditorDraft);
    const settings = useAppStore((s) => s.settings);
    const activeFile = openFiles.find((f) => f.id === activeFileId) ?? null;
    const activeViewStateId = activeViewStateIdProp ?? activeFileId;
    const [fileContents, setFileContents] = useState({});
    const [diffContents, setDiffContents] = useState({});
    const [copiedPathToast, setCopiedPathToast] = useState(null);
    const [renameDialogFileId, setRenameDialogFileId] = useState(null);
    const renameDialogFile = renameDialogFileId
        ? openFiles.find((f) => f.id === renameDialogFileId)
        : null;
    const [sideBySide, setSideBySide] = useState(settings?.diffDefaultView === 'side-by-side');
    const [prevDiffView, setPrevDiffView] = useState(settings?.diffDefaultView);
    const [pathMenuOpen, setPathMenuOpen] = useState(false);
    const [pathMenuPoint, setPathMenuPoint] = useState({ x: 0, y: 0 });
    const deleteCacheEntriesByPrefix = useCallback((cache, prefix) => {
        for (const key of cache.keys()) {
            if (key.startsWith(prefix)) {
                cache.delete(key);
            }
        }
    }, []);
    // Why: When the user changes their global diff-view preference in Settings,
    // sync the local toggle to match during render (avoids flash of stale diff mode).
    if (settings?.diffDefaultView !== prevDiffView) {
        setPrevDiffView(settings?.diffDefaultView);
        if (settings?.diffDefaultView !== undefined) {
            setSideBySide(settings.diffDefaultView === 'side-by-side');
        }
    }
    const openFilesRef = useRef(openFiles);
    openFilesRef.current = openFiles;
    useEffect(() => {
        const closeMenu = () => setPathMenuOpen(false);
        window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu);
        return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu);
    }, []);
    // Why: keepCurrentModel / keepCurrent*Model retain Monaco models after unmount
    // so undo history survives tab switches. When a tab is *closed*, the user has
    // signalled they're done with the file — dispose the models to reclaim memory
    // and delete cache entries so a reopened file starts fresh.
    const prevOpenFilesRef = useRef(new Map());
    useEffect(() => {
        const currentFilesById = new Map(openFiles.map((f) => [f.id, f]));
        for (const [prevId, prevFile] of prevOpenFilesRef.current) {
            if (!currentFilesById.has(prevId)) {
                // Dispose only the kept-alive Monaco state that this tab mode owns.
                // Why: edit and diff tabs use different retained-model keys, while the
                // conflict-review surface does not create kept Monaco models today. An
                // explicit switch makes that ownership boundary visible so future mode
                // additions do not silently fall through without considering cleanup.
                switch (prevFile.mode) {
                    case 'edit':
                        // Why: the edit model URI is constructed via monaco.Uri.parse(filePath)
                        // to match what @monaco-editor/react creates internally when the `path`
                        // prop is provided. This convention is version-dependent.
                        monaco.editor.getModel(monaco.Uri.parse(prevFile.filePath))?.dispose();
                        scrollTopCache.delete(prevFile.filePath);
                        deleteCacheEntriesByPrefix(scrollTopCache, `${prevFile.filePath}::`);
                        // Why: markdown edit tabs cycle through three view modes (source, rich,
                        // preview), each caching scroll under a mode-scoped key. All must be
                        // evicted so a reopened file starts fresh regardless of which mode was
                        // last active.
                        scrollTopCache.delete(`${prevFile.filePath}:rich`);
                        scrollTopCache.delete(`${prevFile.filePath}:preview`);
                        // Why: mermaid files use a mode-scoped cache key just like markdown.
                        // Without this, a reopened .mmd file would restore a stale scroll
                        // position from the previous session even if the content changed.
                        scrollTopCache.delete(`${prevFile.filePath}:mermaid-diagram`);
                        cursorPositionCache.delete(prevFile.filePath);
                        deleteCacheEntriesByPrefix(cursorPositionCache, `${prevFile.filePath}::`);
                        break;
                    case 'diff':
                        // Why: kept diff models are keyed by tab id, not file path, because the
                        // same file can appear in multiple diff tabs with different contents.
                        monaco.editor.getModel(monaco.Uri.parse(`diff:original:${prevId}`))?.dispose();
                        monaco.editor.getModel(monaco.Uri.parse(`diff:modified:${prevId}`))?.dispose();
                        diffViewStateCache.delete(prevId);
                        deleteCacheEntriesByPrefix(diffViewStateCache, `${prevId}::`);
                        break;
                    case 'conflict-review':
                        break;
                }
            }
        }
        prevOpenFilesRef.current = currentFilesById;
    }, [deleteCacheEntriesByPrefix, openFiles]);
    // Load file content when active file changes
    useEffect(() => {
        if (!activeFile) {
            return;
        }
        if (activeFile.mode === 'conflict-review') {
            return;
        }
        if (activeFile.mode === 'edit') {
            if (activeFile.conflict?.kind === 'conflict-placeholder') {
                return;
            }
            if (fileContents[activeFile.id]) {
                return;
            }
            void loadFileContent(activeFile.filePath, activeFile.id, activeFile.worktreeId);
        }
        else if (activeFile.mode === 'diff' &&
            activeFile.diffSource !== undefined &&
            activeFile.diffSource !== 'combined-uncommitted' &&
            activeFile.diffSource !== 'combined-branch') {
            if (diffContents[activeFile.id]) {
                return;
            }
            void loadDiffContent(activeFile);
        }
    }, [activeFile?.id]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (!copiedPathToast) {
            return;
        }
        const timeout = window.setTimeout(() => setCopiedPathToast(null), 1500);
        return () => window.clearTimeout(timeout);
    }, [copiedPathToast]);
    const loadFileContent = useCallback(async (filePath, id, worktreeId) => {
        try {
            const connectionId = getConnectionId(worktreeId ?? null) ?? undefined;
            const result = (await window.api.fs.readFile({ filePath, connectionId }));
            setFileContents((prev) => ({ ...prev, [id]: result }));
        }
        catch (err) {
            setFileContents((prev) => ({
                ...prev,
                [id]: { content: `Error loading file: ${err}`, isBinary: false }
            }));
        }
    }, []);
    const loadDiffContent = useCallback(async (file) => {
        if (!file) {
            return;
        }
        try {
            // Extract worktree path from absolute file path and relative path
            const worktreePath = file.filePath.slice(0, file.filePath.length - file.relativePath.length - 1);
            const branchCompare = file.branchCompare?.baseOid && file.branchCompare.headOid && file.branchCompare.mergeBase
                ? file.branchCompare
                : null;
            const connectionId = getConnectionId(file.worktreeId) ?? undefined;
            const result = file.diffSource === 'branch' && branchCompare
                ? (await window.api.git.branchDiff({
                    worktreePath,
                    compare: {
                        baseRef: branchCompare.baseRef,
                        baseOid: branchCompare.baseOid,
                        headOid: branchCompare.headOid,
                        mergeBase: branchCompare.mergeBase
                    },
                    filePath: file.relativePath,
                    oldPath: file.branchOldPath,
                    connectionId
                }))
                : (await window.api.git.diff({
                    worktreePath,
                    filePath: file.relativePath,
                    staged: file.diffSource === 'staged',
                    connectionId
                }));
            setDiffContents((prev) => ({ ...prev, [file.id]: result }));
        }
        catch (err) {
            setDiffContents((prev) => ({
                ...prev,
                [file.id]: {
                    kind: 'text',
                    originalContent: '',
                    modifiedContent: `Error loading diff: ${err}`,
                    originalIsBinary: false,
                    modifiedIsBinary: false
                }
            }));
        }
    }, []);
    const handleContentChange = useCallback((content) => {
        if (!activeFile) {
            return;
        }
        setEditorDraft(activeFile.id, content);
        // Why: TipTap's getMarkdown() always appends a trailing newline to the
        // serialized output. If the file on disk lacks that newline the naive
        // strict-equality check treats the file as dirty even though no user edit
        // occurred. Normalising trailing whitespace for markdown files mirrors the
        // same trimEnd() used in the round-trip checker (markdown-round-trip.ts).
        const isMarkdown = activeFile.language === 'markdown';
        const normalize = isMarkdown ? (s) => s.trimEnd() : (s) => s;
        if (activeFile.mode === 'edit') {
            const saved = fileContents[activeFile.id]?.content ?? '';
            markFileDirty(activeFile.id, normalize(content) !== normalize(saved));
        }
        else {
            // Diff mode: compare against the original modified content from git
            const dc = diffContents[activeFile.id];
            const original = dc?.kind === 'text' ? dc.modifiedContent : '';
            markFileDirty(activeFile.id, normalize(content) !== normalize(original));
        }
    }, [activeFile, diffContents, fileContents, markFileDirty, setEditorDraft]);
    const handleDirtyStateHint = useCallback((dirty) => {
        if (!activeFile) {
            return;
        }
        // Why: RichMarkdownEditor debounces markdown serialization to keep
        // typing responsive on large documents. The store still needs an
        // immediate dirty signal so close prompts and window-unload guards do
        // not miss edits made in the last debounce window.
        markFileDirty(activeFile.id, dirty);
    }, [activeFile, markFileDirty]);
    const handleSave = useCallback(async (content) => {
        if (!activeFile) {
            return;
        }
        // Why: for untitled files, Cmd+S should prompt for a name before
        // writing anything. Saving first would make Cancel misleading since
        // the write already happened. Show the dialog and let the confirm
        // handler do the save + rename atomically.
        if (activeFile.isUntitled) {
            setRenameDialogFileId(activeFile.id);
            return;
        }
        try {
            await requestEditorFileSave({ fileId: activeFile.id, fallbackContent: content });
        }
        catch { }
    }, [activeFile]);
    // Why: global Cmd+S (from Terminal.tsx) dispatches this event when
    // focus is outside the editor content area. Delegate to handleSave
    // so untitled files still show the rename dialog.
    useEffect(() => {
        const handler = () => {
            if (!activeFile) {
                return;
            }
            // Why: untitled files need the dialog even when there's no draft yet.
            // For regular files, skip the save if there's no draft — the file on
            // disk is already up-to-date, and passing an empty fallback would
            // overwrite it with nothing.
            const draft = useAppStore.getState().editorDrafts[activeFile.id];
            if (!draft && !activeFile.isUntitled) {
                return;
            }
            void handleSave(draft ?? '');
        };
        window.addEventListener(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, handler);
        return () => window.removeEventListener(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, handler);
    }, [activeFile, handleSave]);
    useEffect(() => {
        const handler = (event) => {
            const detail = event.detail;
            if (!detail) {
                return;
            }
            const matchingFiles = getOpenFilesForExternalFileChange(openFilesRef.current, detail);
            if (matchingFiles.length === 0) {
                return;
            }
            setFileContents((prev) => {
                const next = { ...prev };
                for (const file of matchingFiles) {
                    if (file.mode === 'edit') {
                        delete next[file.id];
                    }
                }
                return next;
            });
            setDiffContents((prev) => {
                const next = { ...prev };
                for (const file of matchingFiles) {
                    if (file.mode === 'diff') {
                        delete next[file.id];
                    }
                }
                return next;
            });
            for (const file of matchingFiles) {
                if (file.mode === 'edit') {
                    void loadFileContent(file.filePath, file.id, file.worktreeId);
                }
                else if (file.mode === 'diff' &&
                    file.diffSource !== 'combined-uncommitted' &&
                    file.diffSource !== 'combined-branch') {
                    void loadDiffContent(file);
                }
            }
        };
        window.addEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, handler);
        return () => window.removeEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, handler);
    }, [loadDiffContent, loadFileContent]);
    useEffect(() => {
        const openIds = new Set(openFiles.map((f) => f.id));
        setFileContents((prev) => {
            const next = {};
            for (const [k, v] of Object.entries(prev)) {
                if (openIds.has(k)) {
                    next[k] = v;
                }
            }
            return next;
        });
        setDiffContents((prev) => {
            const next = {};
            for (const [k, v] of Object.entries(prev)) {
                if (openIds.has(k)) {
                    next[k] = v;
                }
            }
            return next;
        });
    }, [openFiles]);
    useEffect(() => {
        const handler = (event) => {
            const detail = event.detail;
            if (!detail) {
                return;
            }
            const file = openFilesRef.current.find((openFile) => openFile.id === detail.fileId);
            if (!file) {
                return;
            }
            if (file.mode === 'edit') {
                setFileContents((prev) => ({
                    ...prev,
                    [file.id]: { content: detail.content, isBinary: false }
                }));
                return;
            }
            setDiffContents((prev) => {
                const existing = prev[file.id];
                if (!existing || existing.kind !== 'text') {
                    return prev;
                }
                return {
                    ...prev,
                    [file.id]: { ...existing, modifiedContent: detail.content }
                };
            });
        };
        window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, handler);
        return () => window.removeEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, handler);
    }, []);
    const [renameError, setRenameError] = useState(null);
    const handleRenameConfirm = useCallback(async (newRelPath) => {
        if (!renameDialogFile) {
            return;
        }
        const oldPath = renameDialogFile.filePath;
        // Why: worktree path is derived by stripping the old relativePath
        // suffix, so subdirectory-relative names (e.g. "notes/ideas.md")
        // resolve correctly against the worktree root.
        const worktreeRoot = oldPath.slice(0, oldPath.length - renameDialogFile.relativePath.length - 1);
        const newPath = `${worktreeRoot}/${newRelPath}`;
        // Prevent silently overwriting an existing file (but allow keeping
        // the current name — the file's own path is not a conflict).
        if (newPath !== oldPath && (await window.api.shell.pathExists(newPath))) {
            setRenameError('A file with that name already exists');
            return;
        }
        // Why: Cmd+S no longer pre-saves for untitled files — it just opens
        // this dialog. Flush any pending autosave, then save the current
        // content so the file on disk is up-to-date before we rename it.
        await requestEditorSaveQuiesce({ fileId: renameDialogFile.id });
        // Why: only trigger a save if there's actually unsaved content.
        // Passing an empty fallbackContent when the draft is absent would
        // overwrite the file with nothing, wiping user content.
        const draft = useAppStore.getState().editorDrafts[renameDialogFile.id];
        if (draft !== undefined) {
            try {
                await requestEditorFileSave({ fileId: renameDialogFile.id, fallbackContent: draft });
            }
            catch {
                // Why: if the save fails (disk full, permissions, etc.), abort the
                // rename to avoid moving a stale/empty file and losing content.
                setRenameError('Failed to save file');
                return;
            }
        }
        // User kept the same name — just save in place, no rename needed.
        if (newPath === oldPath) {
            clearUntitled(renameDialogFile.id);
            setRenameDialogFileId(null);
            setRenameError(null);
            return;
        }
        // Why: if the target path includes subdirectories (e.g. "notes/ideas.md"),
        // ensure the parent directory exists before renaming. createDir throws
        // if the directory already exists (assertNotExists guard), so only call
        // it when the directory is not yet on disk.
        const newDir = newPath.slice(0, newPath.lastIndexOf('/'));
        if (newDir !== worktreeRoot && !(await window.api.shell.pathExists(newDir))) {
            await window.api.fs.createDir({ dirPath: newDir });
        }
        try {
            await window.api.fs.rename({ oldPath, newPath });
        }
        catch (err) {
            setRenameError(err instanceof Error ? err.message : 'Failed to rename file');
            return;
        }
        closeFile(oldPath);
        openFile({
            filePath: newPath,
            relativePath: newRelPath,
            worktreeId: renameDialogFile.worktreeId,
            language: detectLanguage(newRelPath),
            mode: 'edit'
        });
        // Why: Cmd+S already saved the content before the rename dialog opened,
        // and quiesce flushed any remaining writes. The renamed file on disk
        // matches the editor content, so the new tab should start clean.
        setRenameDialogFileId(null);
        setRenameError(null);
    }, [renameDialogFile, closeFile, openFile, clearUntitled]);
    const handleCopyPath = useCallback(async () => {
        if (!activeFile) {
            return;
        }
        const copyState = getEditorHeaderCopyState(activeFile);
        if (!copyState.copyText) {
            return;
        }
        try {
            await window.api.ui.writeClipboardText(copyState.copyText);
            setCopiedPathToast({ fileId: activeFile.id, token: Date.now() });
        }
        catch {
            setCopiedPathToast(null);
        }
    }, [activeFile]);
    if (!activeFile) {
        return null;
    }
    const isSingleDiff = activeFile.mode === 'diff' &&
        activeFile.diffSource !== undefined &&
        activeFile.diffSource !== 'combined-uncommitted' &&
        activeFile.diffSource !== 'combined-branch';
    const isCombinedDiff = activeFile.mode === 'diff' &&
        (activeFile.diffSource === 'combined-uncommitted' ||
            activeFile.diffSource === 'combined-branch');
    const headerCopyState = getEditorHeaderCopyState(activeFile);
    const worktreeEntries = gitStatusByWorktree[activeFile.worktreeId] ?? [];
    const branchEntries = gitBranchChangesByWorktree[activeFile.worktreeId] ?? [];
    const resolvedLanguage = activeFile.mode === 'diff'
        ? detectLanguage(activeFile.relativePath)
        : detectLanguage(activeFile.filePath);
    const matchingWorktreeEntry = activeFile.mode === 'diff' && activeFile.diffSource !== 'branch'
        ? (worktreeEntries.find((entry) => entry.path === activeFile.relativePath &&
            (activeFile.diffSource === 'staged'
                ? entry.area === 'staged'
                : entry.area === 'unstaged')) ?? null)
        : null;
    const matchingBranchEntry = activeFile.mode === 'diff' && activeFile.diffSource === 'branch'
        ? (branchEntries.find((entry) => entry.path === activeFile.relativePath) ?? null)
        : null;
    const openFileState = getEditorHeaderOpenFileState(activeFile, matchingWorktreeEntry, matchingBranchEntry);
    const isMarkdown = resolvedLanguage === 'markdown';
    const isMermaid = resolvedLanguage === 'mermaid';
    // Why: mermaid files reuse the same per-file view mode store as markdown.
    // Both default to 'rich' (rendered view) and fall back to 'source' (Monaco).
    const hasViewModeToggle = (isMarkdown || isMermaid) && activeFile.mode === 'edit';
    const mdViewMode = hasViewModeToggle
        ? (markdownViewMode[activeFile.id] ?? 'rich')
        : 'source';
    const handleOpenDiffTargetFile = () => {
        if (!openFileState.canOpen) {
            return;
        }
        openFile({
            filePath: activeFile.filePath,
            relativePath: activeFile.relativePath,
            worktreeId: activeFile.worktreeId,
            language: detectLanguage(activeFile.relativePath),
            mode: 'edit'
        });
    };
    const loadingFallback = (_jsx("div", { className: "flex items-center justify-center h-full text-muted-foreground text-sm", children: "Loading editor..." }));
    return (_jsxs("div", { className: "flex flex-col flex-1 min-w-0 min-h-0", children: [!isCombinedDiff && (_jsxs("div", { className: "editor-header", children: [_jsxs("div", { className: "editor-header-text", children: [_jsxs("div", { className: "editor-header-path-row", onContextMenuCapture: (event) => {
                                    event.preventDefault();
                                    window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT));
                                    setPathMenuPoint({ x: event.clientX, y: event.clientY });
                                    setPathMenuOpen(true);
                                }, children: [_jsx("button", { type: "button", className: "editor-header-path", onClick: () => void handleCopyPath(), title: headerCopyState.pathTitle, children: headerCopyState.pathLabel }), _jsx("span", { className: `editor-header-copy-toast${copiedPathToast?.fileId === activeFile.id ? ' is-visible' : ''}`, "aria-live": "polite", children: headerCopyState.copyToastLabel })] }), _jsxs(DropdownMenu, { open: pathMenuOpen, onOpenChange: setPathMenuOpen, modal: false, children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsx("button", { "aria-hidden": true, tabIndex: -1, className: "pointer-events-none fixed size-px opacity-0", style: { left: pathMenuPoint.x, top: pathMenuPoint.y } }) }), _jsxs(DropdownMenuContent, { className: "w-56", sideOffset: 0, align: "start", children: [_jsxs(DropdownMenuItem, { onSelect: () => {
                                                    void window.api.ui.writeClipboardText(activeFile.filePath);
                                                }, children: [_jsx(Copy, { className: "w-3.5 h-3.5 mr-1.5" }), "Copy Path"] }), _jsxs(DropdownMenuItem, { onSelect: () => {
                                                    void window.api.ui.writeClipboardText(activeFile.relativePath);
                                                }, children: [_jsx(Copy, { className: "w-3.5 h-3.5 mr-1.5" }), "Copy Relative Path"] }), _jsx(DropdownMenuSeparator, {}), _jsxs(DropdownMenuItem, { onSelect: () => {
                                                    window.api.shell.openPath(activeFile.filePath);
                                                }, children: [_jsx(ExternalLink, { className: "w-3.5 h-3.5 mr-1.5" }), revealLabel] })] })] })] }), isSingleDiff && (_jsx(TooltipProvider, { delayDuration: 300, children: _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx("button", { type: "button", className: "p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground", onClick: handleOpenDiffTargetFile, "aria-label": "Open file", disabled: !openFileState.canOpen, children: _jsx(FileText, { size: 14 }) }) }), _jsx(TooltipContent, { side: "bottom", sideOffset: 4, children: openFileState.canOpen
                                        ? isMarkdown
                                            ? 'Open file tab to use rich markdown editing'
                                            : 'Open file tab'
                                        : 'This diff has no modified-side file to open' })] }) })), isSingleDiff && (_jsx(TooltipProvider, { delayDuration: 300, children: _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx("button", { className: "p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0", onClick: () => setSideBySide((prev) => !prev), children: sideBySide ? _jsx(Rows2, { size: 14 }) : _jsx(Columns2, { size: 14 }) }) }), _jsx(TooltipContent, { side: "bottom", sideOffset: 4, children: sideBySide ? 'Switch to inline diff' : 'Switch to side-by-side diff' })] }) })), hasViewModeToggle && (_jsx(MarkdownViewToggle, { mode: mdViewMode, onChange: (mode) => setMarkdownViewMode(activeFile.id, mode) }))] })), _jsx(Suspense, { fallback: loadingFallback, children: _jsx(EditorContent, { activeFile: activeFile, viewStateScopeId: activeViewStateId ?? activeFile.id, fileContents: fileContents, diffContents: diffContents, editBuffers: editorDrafts, worktreeEntries: worktreeEntries, resolvedLanguage: resolvedLanguage, isMarkdown: isMarkdown, isMermaid: isMermaid, mdViewMode: mdViewMode, sideBySide: sideBySide, pendingEditorReveal: pendingEditorReveal, handleContentChange: handleContentChange, handleDirtyStateHint: handleDirtyStateHint, handleSave: handleSave }) }), _jsx(UntitledFileRenameDialog, { open: renameDialogFile !== undefined && renameDialogFile !== null, currentName: renameDialogFile?.relativePath ?? '', worktreePath: renameDialogFile
                    ? (findWorktreeById(useAppStore.getState().worktreesByRepo, renameDialogFile.worktreeId)
                        ?.path ?? '')
                    : '', externalError: renameError, onClose: () => {
                    setRenameDialogFileId(null);
                    setRenameError(null);
                }, onConfirm: handleRenameConfirm })] }));
}
export default React.memo(EditorPanelInner);
