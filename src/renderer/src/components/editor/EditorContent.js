import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { lazy } from 'react';
import { detectLanguage } from '@/lib/language-detect';
import { useAppStore } from '@/store';
import { ConflictBanner, ConflictPlaceholderView, ConflictReviewPanel } from './ConflictComponents';
import { RICH_MARKDOWN_MAX_SIZE_BYTES } from '../../../../shared/constants';
import { getMarkdownRenderMode } from './markdown-render-mode';
import { getMarkdownRichModeUnsupportedMessage } from './markdown-rich-mode';
import { extractFrontMatter, prependFrontMatter } from './markdown-frontmatter';
const MonacoEditor = lazy(() => import('./MonacoEditor'));
const DiffViewer = lazy(() => import('./DiffViewer'));
const CombinedDiffViewer = lazy(() => import('./CombinedDiffViewer'));
const DiffCommentsTab = lazy(() => import('../diff-comments/DiffCommentsTab').then((m) => ({ default: m.DiffCommentsTab })));
const RichMarkdownEditor = lazy(() => import('./RichMarkdownEditor'));
const MarkdownPreview = lazy(() => import('./MarkdownPreview'));
const ImageViewer = lazy(() => import('./ImageViewer'));
const ImageDiffViewer = lazy(() => import('./ImageDiffViewer'));
const MermaidViewer = lazy(() => import('./MermaidViewer'));
const richMarkdownSizeEncoder = new TextEncoder();
// Why: encodeInto() with a pre-allocated buffer avoids creating a new
// Uint8Array on every render, reducing GC pressure for large files.
const richMarkdownSizeBuffer = new Uint8Array(RICH_MARKDOWN_MAX_SIZE_BYTES + 1);
export function EditorContent({ activeFile, viewStateScopeId, fileContents, diffContents, editBuffers, worktreeEntries, resolvedLanguage, isMarkdown, isMermaid, mdViewMode, sideBySide, pendingEditorReveal, handleContentChange, handleDirtyStateHint, handleSave }) {
    const editorViewStateKey = viewStateScopeId === activeFile.id
        ? activeFile.filePath
        : `${activeFile.filePath}::${viewStateScopeId}`;
    const diffViewStateKey = viewStateScopeId === activeFile.id ? activeFile.id : `${activeFile.id}::${viewStateScopeId}`;
    const openConflictFile = useAppStore((s) => s.openConflictFile);
    const openConflictReview = useAppStore((s) => s.openConflictReview);
    const closeFile = useAppStore((s) => s.closeFile);
    const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab);
    const activeConflictEntry = worktreeEntries.find((entry) => entry.path === activeFile.relativePath) ?? null;
    const isCombinedDiff = activeFile.mode === 'diff' &&
        (activeFile.diffSource === 'combined-uncommitted' ||
            activeFile.diffSource === 'combined-branch');
    const renderMonacoEditor = (fc) => (
    // Why: Without a key, React reuses the same MonacoEditor instance when
    // switching tabs or split panes, just updating props. That means
    // useLayoutEffect cleanup (which snapshots scroll position) never fires.
    // Keying on the visible pane identity forces unmount/remount so each split
    // tab keeps its own viewport state even when the underlying file is shared.
    _jsx(MonacoEditor, { filePath: activeFile.filePath, viewStateKey: editorViewStateKey, relativePath: activeFile.relativePath, content: editBuffers[activeFile.id] ?? fc.content, language: resolvedLanguage, onContentChange: handleContentChange, onSave: handleSave, revealLine: pendingEditorReveal?.filePath === activeFile.filePath ? pendingEditorReveal.line : undefined, revealColumn: pendingEditorReveal?.filePath === activeFile.filePath
            ? pendingEditorReveal.column
            : undefined, revealMatchLength: pendingEditorReveal?.filePath === activeFile.filePath
            ? pendingEditorReveal.matchLength
            : undefined }, viewStateScopeId));
    const renderMarkdownContent = (fc) => {
        const currentContent = editBuffers[activeFile.id] ?? fc.content;
        const richModeUnsupportedMessage = getMarkdownRichModeUnsupportedMessage(currentContent);
        const renderMode = getMarkdownRenderMode({
            // Why: the threshold is defined in bytes because large pasted Unicode
            // documents can exceed ProseMirror's performance envelope long before
            // JS string length reaches the same numeric value.
            exceedsRichModeSizeLimit: richMarkdownSizeEncoder.encodeInto(currentContent, richMarkdownSizeBuffer).written >
                RICH_MARKDOWN_MAX_SIZE_BYTES,
            hasRichModeUnsupportedContent: richModeUnsupportedMessage !== null,
            viewMode: mdViewMode
        });
        // Why: the render-mode helper already folded size into the mode decision.
        // Keep the explanatory banner here so the user understands why "rich" view
        // currently shows Monaco instead.
        if (renderMode === 'source' && mdViewMode === 'rich') {
            return (_jsxs("div", { className: "flex h-full min-h-0 flex-col", children: [_jsx("div", { className: "border-b border-border/60 bg-blue-500/10 px-3 py-2 text-xs text-blue-950 dark:text-blue-100", children: "File is too large for rich editing. Showing source mode instead." }), _jsx("div", { className: "min-h-0 flex-1 h-full", children: renderMonacoEditor(fc) })] }));
        }
        if (renderMode === 'rich-editor') {
            // Why: front-matter is stripped before the rich editor sees the content
            // because Tiptap has no front-matter node and would silently drop it.
            // The raw block is displayed as a read-only banner and recombined with
            // the body on every content change and save so the edit buffer always
            // holds the complete document.
            const fm = extractFrontMatter(currentContent);
            const editorContent = fm ? fm.body : currentContent;
            const onContentChangeWithFm = fm
                ? (body) => handleContentChange(prependFrontMatter(fm.raw, body))
                : handleContentChange;
            const onSaveWithFm = fm
                ? (body) => handleSave(prependFrontMatter(fm.raw, body))
                : handleSave;
            return (_jsxs("div", { className: "flex h-full min-h-0 flex-col", children: [fm && _jsx(FrontMatterBanner, { raw: fm.raw }), _jsx("div", { className: "min-h-0 flex-1", children: _jsx(RichMarkdownEditor, { fileId: activeFile.id, content: editorContent, filePath: activeFile.filePath, scrollCacheKey: `${editorViewStateKey}:rich`, onContentChange: onContentChangeWithFm, onDirtyStateHint: handleDirtyStateHint, onSave: onSaveWithFm }, viewStateScopeId) })] }));
        }
        if (renderMode === 'preview') {
            return (_jsxs("div", { className: "flex h-full min-h-0 flex-col", children: [_jsx("div", { className: "border-b border-border/60 bg-amber-500/10 px-3 py-2 text-xs text-amber-950 dark:text-amber-100", children: richModeUnsupportedMessage }), _jsx("div", { className: "min-h-0 flex-1", children: _jsx(MarkdownPreview, { content: currentContent, filePath: activeFile.filePath, scrollCacheKey: `${editorViewStateKey}:preview` }, viewStateScopeId) })] }));
        }
        // Why: Monaco sizes itself against the immediate parent when `height="100%"`
        // is used. Markdown source mode briefly wrapped it in a non-flex container
        // with no explicit height, which made the code surface collapse even though
        // the surrounding editor pane was tall enough.
        return _jsx("div", { className: "h-full min-h-0", children: renderMonacoEditor(fc) });
    };
    if (activeFile.mode === 'diff-comments') {
        return _jsx(DiffCommentsTab, { activeFile: activeFile });
    }
    if (activeFile.mode === 'conflict-review') {
        return (_jsx(ConflictReviewPanel, { file: activeFile, liveEntries: worktreeEntries, onOpenEntry: (entry) => openConflictFile(activeFile.worktreeId, activeFile.filePath, entry, detectLanguage(entry.path)), onDismiss: () => closeFile(activeFile.id), onRefreshSnapshot: () => openConflictReview(activeFile.worktreeId, activeFile.filePath, worktreeEntries
                .filter((entry) => entry.conflictStatus === 'unresolved' && entry.conflictKind)
                .map((entry) => ({
                path: entry.path,
                conflictKind: entry.conflictKind
            })), 'live-summary'), onReturnToSourceControl: () => setRightSidebarTab('source-control') }));
    }
    if (isCombinedDiff) {
        return (_jsx(CombinedDiffViewer, { file: activeFile, viewStateKey: diffViewStateKey }, viewStateScopeId));
    }
    if (activeFile.mode === 'edit') {
        if (activeFile.conflict?.kind === 'conflict-placeholder') {
            return _jsx(ConflictPlaceholderView, { file: activeFile });
        }
        const fc = fileContents[activeFile.id];
        if (!fc) {
            return (_jsx("div", { className: "flex items-center justify-center h-full text-muted-foreground text-sm", children: "Loading..." }));
        }
        if (fc.isBinary) {
            if (fc.isImage) {
                return (_jsx(ImageViewer, { content: fc.content, filePath: activeFile.filePath, mimeType: fc.mimeType }));
            }
            return (_jsx("div", { className: "flex items-center justify-center h-full text-muted-foreground text-sm", children: "Binary file \u2014 cannot display" }));
        }
        return (_jsxs("div", { className: "flex flex-1 min-h-0 flex-col", children: [activeFile.conflict && _jsx(ConflictBanner, { file: activeFile, entry: activeConflictEntry }), _jsx("div", { className: "min-h-0 flex-1 relative", children: isMarkdown ? (renderMarkdownContent(fc)) : isMermaid && mdViewMode === 'rich' ? (_jsx(MermaidViewer, { content: editBuffers[activeFile.id] ?? fc.content, filePath: activeFile.filePath }, activeFile.id)) : (renderMonacoEditor(fc)) })] }));
    }
    // Diff mode
    const dc = diffContents[activeFile.id];
    if (!dc) {
        return (_jsx("div", { className: "flex items-center justify-center h-full text-muted-foreground text-sm", children: "Loading diff..." }));
    }
    const isEditable = activeFile.diffSource === 'unstaged';
    if (dc.kind === 'binary') {
        if (dc.isImage) {
            return (_jsx(ImageDiffViewer, { originalContent: dc.originalContent, modifiedContent: dc.modifiedContent, filePath: activeFile.relativePath, mimeType: dc.mimeType, sideBySide: sideBySide }));
        }
        return (_jsx("div", { className: "flex h-full items-center justify-center px-6 text-center", children: _jsxs("div", { className: "space-y-2", children: [_jsx("div", { className: "text-sm font-medium text-foreground", children: "Binary file changed" }), _jsx("div", { className: "text-xs text-muted-foreground", children: activeFile.diffSource === 'branch'
                            ? 'Text diff is unavailable for this file in branch compare.'
                            : 'Text diff is unavailable for this file.' })] }) }));
    }
    return (_jsx(DiffViewer, { modelKey: diffViewStateKey, originalContent: dc.originalContent, modifiedContent: editBuffers[activeFile.id] ?? dc.modifiedContent, language: resolvedLanguage, filePath: activeFile.filePath, relativePath: activeFile.relativePath, sideBySide: sideBySide, editable: isEditable, onContentChange: isEditable ? handleContentChange : undefined, onSave: isEditable ? handleSave : undefined }, viewStateScopeId));
}
// Why: a minimal read-only banner that shows the raw front-matter content
// above the rich editor so the user knows it exists and can switch to source
// mode to edit it. Kept deliberately simple — no collapsible state — to avoid
// layout shifts that would interfere with ProseMirror's scroll management.
function FrontMatterBanner({ raw }) {
    // Strip the opening/closing delimiters to show only the YAML/TOML content.
    const inner = raw
        .replace(/^(?:---|\+\+\+)\r?\n/, '')
        .replace(/\r?\n(?:---|\+\+\+)\r?\n?$/, '')
        .trim();
    return (_jsxs("div", { className: "border-b border-border/60 bg-muted/40 px-3 py-2", children: [_jsxs("div", { className: "mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground", children: ["Front Matter", _jsx("span", { className: "ml-2 font-normal normal-case tracking-normal opacity-70", children: "(edit in source mode)" })] }), _jsx("pre", { className: "max-h-32 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground font-mono scrollbar-editor", children: inner })] }));
}
