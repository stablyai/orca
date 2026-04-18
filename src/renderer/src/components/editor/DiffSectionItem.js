import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { lazy, useMemo, useState } from 'react';
import { LazySection } from './LazySection';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { DiffEditor } from '@monaco-editor/react';
import { joinPath } from '@/lib/path';
import { detectLanguage } from '@/lib/language-detect';
import { useAppStore } from '@/store';
import { computeEditorFontSize } from '@/lib/editor-font-zoom';
import { findWorktreeById } from '@/store/slices/worktree-helpers';
import { useDiffCommentDecorator } from '../diff-comments/useDiffCommentDecorator';
import { DiffCommentPopover } from '../diff-comments/DiffCommentPopover';
const ImageDiffViewer = lazy(() => import('./ImageDiffViewer'));
/**
 * Compute approximate added/removed line counts by matching lines
 * between original and modified content using a multiset approach.
 * Not a true Myers diff, but fast and accurate enough for stat display.
 */
function computeLineStats(original, modified, status) {
    // Why: for very large files (e.g. package-lock.json), splitting and
    // iterating synchronously in the React render cycle would block the
    // main thread and freeze the UI. Return null to skip stats display.
    if (original.length + modified.length > 500_000) {
        return null;
    }
    if (status === 'added') {
        return { added: modified ? modified.split('\n').length : 0, removed: 0 };
    }
    if (status === 'deleted') {
        return { added: 0, removed: original ? original.split('\n').length : 0 };
    }
    const origLines = original.split('\n');
    const modLines = modified.split('\n');
    const origMap = new Map();
    for (const line of origLines) {
        origMap.set(line, (origMap.get(line) ?? 0) + 1);
    }
    let matched = 0;
    for (const line of modLines) {
        const count = origMap.get(line) ?? 0;
        if (count > 0) {
            origMap.set(line, count - 1);
            matched++;
        }
    }
    return {
        added: modLines.length - matched,
        removed: origLines.length - matched
    };
}
export function DiffSectionItem({ section, index, isBranchMode, sideBySide, isDark, settings, sectionHeight, worktreeId, worktreeRoot, loadSection, toggleSection, setSectionHeights, setSections, modifiedEditorsRef, handleSectionSaveRef }) {
    const openFile = useAppStore((s) => s.openFile);
    const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel);
    const addDiffComment = useAppStore((s) => s.addDiffComment);
    const deleteDiffComment = useAppStore((s) => s.deleteDiffComment);
    // Why: subscribe to the raw comments array on the worktree (reference-
    // stable across unrelated store updates) and filter by filePath inside a
    // memo. Selecting a fresh `.filter(...)` result would invalidate on every
    // store change and cause needless re-renders of this section.
    const allDiffComments = useAppStore((s) => findWorktreeById(s.worktreesByRepo, worktreeId)?.diffComments);
    const diffComments = useMemo(() => (allDiffComments ?? []).filter((c) => c.filePath === section.path), [allDiffComments, section.path]);
    const language = detectLanguage(section.path);
    const isEditable = section.area === 'unstaged';
    const editorFontSize = computeEditorFontSize(settings?.terminalFontSize ?? 13, editorFontZoomLevel);
    const [modifiedEditor, setModifiedEditor] = useState(null);
    const [popover, setPopover] = useState(null);
    useDiffCommentDecorator({
        editor: modifiedEditor,
        filePath: section.path,
        worktreeId,
        comments: diffComments,
        onAddCommentClick: ({ lineNumber, top }) => setPopover({ lineNumber, top }),
        onDeleteComment: (id) => void deleteDiffComment(worktreeId, id)
    });
    const handleSubmitComment = (body) => {
        if (!popover) {
            return;
        }
        void addDiffComment({
            worktreeId,
            filePath: section.path,
            lineNumber: popover.lineNumber,
            body,
            side: 'modified'
        });
        setPopover(null);
    };
    const lineStats = useMemo(() => section.loading
        ? null
        : computeLineStats(section.originalContent, section.modifiedContent, section.status), [section.loading, section.originalContent, section.modifiedContent, section.status]);
    const handleOpenInEditor = (e) => {
        e.stopPropagation();
        const absolutePath = joinPath(worktreeRoot, section.path);
        openFile({
            filePath: absolutePath,
            relativePath: section.path,
            worktreeId,
            language,
            mode: 'edit'
        });
    };
    const handleMount = (editor, monaco) => {
        const modified = editor.getModifiedEditor();
        const updateHeight = () => {
            const contentHeight = editor.getModifiedEditor().getContentHeight();
            setSectionHeights((prev) => {
                if (prev[index] === contentHeight) {
                    return prev;
                }
                return { ...prev, [index]: contentHeight };
            });
        };
        modified.onDidContentSizeChange(updateHeight);
        updateHeight();
        setModifiedEditor(modified);
        if (!isEditable) {
            return;
        }
        modifiedEditorsRef.current.set(index, modified);
        modified.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => handleSectionSaveRef.current(index));
        modified.onDidChangeModelContent(() => {
            const current = modified.getValue();
            setSections((prev) => prev.map((s, i) => (i === index ? { ...s, dirty: current !== s.modifiedContent } : s)));
        });
    };
    return (_jsxs(LazySection, { index: index, onVisible: loadSection, children: [_jsxs("div", { className: "sticky top-0 z-10 bg-background flex items-center w-full px-3 py-1.5 text-left text-xs hover:bg-accent transition-colors group cursor-pointer", onClick: () => toggleSection(index), children: [_jsxs("span", { className: "min-w-0 flex-1 truncate text-muted-foreground", children: [_jsx("span", { role: "button", tabIndex: 0, className: "cursor-copy hover:underline", onMouseDown: (e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                }, onClick: (e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    // Why: stop both mouse-down and click on the path affordance so
                                    // the parent section-toggle row cannot consume the interaction
                                    // before the Electron clipboard write runs.
                                    void window.api.ui.writeClipboardText(section.path).catch((err) => {
                                        console.error('Failed to copy diff path:', err);
                                    });
                                }, onKeyDown: (e) => {
                                    if (e.key !== 'Enter' && e.key !== ' ') {
                                        return;
                                    }
                                    e.preventDefault();
                                    e.stopPropagation();
                                    void window.api.ui.writeClipboardText(section.path).catch((err) => {
                                        console.error('Failed to copy diff path:', err);
                                    });
                                }, title: "Copy path", children: section.path }), section.dirty && _jsx("span", { className: "font-medium ml-1", children: "M" }), lineStats && (lineStats.added > 0 || lineStats.removed > 0) && (_jsxs("span", { className: "tabular-nums ml-2", children: [lineStats.added > 0 && (_jsxs("span", { className: "text-green-600 dark:text-green-500", children: ["+", lineStats.added] })), lineStats.added > 0 && lineStats.removed > 0 && _jsx("span", { children: " " }), lineStats.removed > 0 && _jsxs("span", { className: "text-red-500", children: ["-", lineStats.removed] })] }))] }), _jsxs("div", { className: "flex items-center gap-1 shrink-0 ml-2", children: [_jsx("button", { className: "p-0.5 rounded text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity", onClick: handleOpenInEditor, title: "Open in editor", children: _jsx(ExternalLink, { className: "size-3.5" }) }), section.collapsed ? (_jsx(ChevronRight, { className: "size-3.5 shrink-0 text-muted-foreground" })) : (_jsx(ChevronDown, { className: "size-3.5 shrink-0 text-muted-foreground" }))] })] }), !section.collapsed && (_jsxs("div", { className: "relative", style: {
                    height: sectionHeight
                        ? sectionHeight + 19
                        : Math.max(60, Math.max(section.originalContent.split('\n').length, section.modifiedContent.split('\n').length) *
                            19 +
                            19)
                }, children: [popover && (_jsx(DiffCommentPopover, { lineNumber: popover.lineNumber, top: popover.top, onCancel: () => setPopover(null), onSubmit: handleSubmitComment })), section.loading ? (_jsx("div", { className: "flex items-center justify-center h-full text-muted-foreground text-xs", children: "Loading..." })) : section.diffResult?.kind === 'binary' ? (section.diffResult.isImage ? (_jsx(ImageDiffViewer, { originalContent: section.diffResult.originalContent, modifiedContent: section.diffResult.modifiedContent, filePath: section.path, mimeType: section.diffResult.mimeType, sideBySide: sideBySide })) : (_jsx("div", { className: "flex h-full items-center justify-center px-6 text-center", children: _jsxs("div", { className: "space-y-2", children: [_jsx("div", { className: "text-sm font-medium text-foreground", children: "Binary file changed" }), _jsx("div", { className: "text-xs text-muted-foreground", children: isBranchMode
                                        ? 'Text diff is unavailable for this file in branch compare.'
                                        : 'Text diff is unavailable for this file.' })] }) }))) : (_jsx(DiffEditor, { height: "100%", language: language, original: section.originalContent, modified: section.modifiedContent, theme: isDark ? 'vs-dark' : 'vs', onMount: handleMount, options: {
                            readOnly: !isEditable,
                            originalEditable: false,
                            renderSideBySide: sideBySide,
                            minimap: { enabled: false },
                            scrollBeyondLastLine: false,
                            fontSize: editorFontSize,
                            fontFamily: settings?.terminalFontFamily || 'monospace',
                            lineNumbers: 'on',
                            automaticLayout: true,
                            renderOverviewRuler: false,
                            scrollbar: { vertical: 'hidden', handleMouseWheel: false },
                            hideUnchangedRegions: { enabled: true },
                            find: {
                                addExtraSpaceOnTop: false,
                                autoFindInSelection: 'never',
                                seedSearchStringFromSelection: 'never'
                            }
                        } }))] }))] }, section.key));
}
