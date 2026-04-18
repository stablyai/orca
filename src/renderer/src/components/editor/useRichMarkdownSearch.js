import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TextSelection } from '@tiptap/pm/state';
import { isMarkdownPreviewFindShortcut } from './markdown-preview-search';
import { createRichMarkdownSearchPlugin, findRichMarkdownSearchMatches, richMarkdownSearchPluginKey } from './rich-markdown-search';
export function useRichMarkdownSearch({ editor, isMac, rootRef }) {
    const searchInputRef = useRef(null);
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [rawActiveMatchIndex, setRawActiveMatchIndex] = useState(-1);
    const [searchRevision, setSearchRevision] = useState(0);
    // Why: memoizing the match array avoids the old two-effect pattern where both
    // effects independently called findRichMarkdownSearchMatches on every change.
    const matches = useMemo(() => {
        if (!editor || !isSearchOpen || !searchQuery) {
            return [];
        }
        return findRichMarkdownSearchMatches(editor.state.doc, searchQuery);
        // searchRevision is bumped on ProseMirror doc edits to trigger recomputation
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editor, isSearchOpen, searchQuery, searchRevision]);
    const matchCount = matches.length;
    // Clamp the user-controlled index to the valid range on every render.
    // No state update needed — this is a pure derivation.
    const activeMatchIndex = !isSearchOpen || matchCount === 0
        ? -1
        : rawActiveMatchIndex >= 0 && rawActiveMatchIndex < matchCount
            ? rawActiveMatchIndex
            : matchCount > 0
                ? 0
                : -1;
    const openSearch = useCallback(() => {
        setIsSearchOpen(true);
    }, []);
    const closeSearch = useCallback(() => {
        setIsSearchOpen(false);
        setSearchQuery('');
        setRawActiveMatchIndex(-1);
    }, []);
    const moveToMatch = useCallback((direction) => {
        if (matchCount === 0) {
            return;
        }
        setRawActiveMatchIndex((currentIndex) => {
            const baseIndex = currentIndex >= 0 ? currentIndex : direction === 1 ? -1 : 0;
            return (baseIndex + direction + matchCount) % matchCount;
        });
    }, [matchCount]);
    const handleEditorUpdate = useCallback(() => {
        setSearchRevision((current) => current + 1);
    }, []);
    useEffect(() => {
        if (!editor) {
            return;
        }
        const plugin = createRichMarkdownSearchPlugin();
        editor.registerPlugin(plugin);
        return () => {
            editor.unregisterPlugin(richMarkdownSearchPluginKey);
        };
    }, [editor]);
    useEffect(() => {
        if (!editor) {
            return;
        }
        editor.on('update', handleEditorUpdate);
        return () => {
            editor.off('update', handleEditorUpdate);
        };
    }, [editor, handleEditorUpdate]);
    useEffect(() => {
        if (!isSearchOpen) {
            return;
        }
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
    }, [isSearchOpen]);
    // Why: single effect to sync search state to ProseMirror. The old two-effect
    // chain (compute matches → set state → dispatch) caused an extra render cycle
    // and called findRichMarkdownSearchMatches twice per change.
    useEffect(() => {
        if (!editor) {
            return;
        }
        const query = isSearchOpen ? searchQuery : '';
        editor.view.dispatch(editor.state.tr.setMeta(richMarkdownSearchPluginKey, {
            activeIndex: activeMatchIndex,
            query
        }));
        if (!query || activeMatchIndex < 0) {
            return;
        }
        const activeMatch = matches[activeMatchIndex];
        if (!activeMatch) {
            return;
        }
        // Why: rich-mode find should navigate within the editor model instead of
        // the rendered DOM so highlight positions stay correct while the user edits.
        // Updating the ProseMirror selection keeps scroll-to-match aligned with the
        // actual markdown document rather than the transient browser layout.
        const tr = editor.state.tr;
        tr.setSelection(TextSelection.create(tr.doc, activeMatch.from, activeMatch.to));
        tr.scrollIntoView();
        editor.view.dispatch(tr);
    }, [activeMatchIndex, editor, isSearchOpen, matches, searchQuery]);
    useEffect(() => {
        const handleKeyDown = (event) => {
            const root = rootRef.current;
            if (!root) {
                return;
            }
            const target = event.target;
            const targetInsideEditor = target instanceof Node && root.contains(target);
            if (isMarkdownPreviewFindShortcut(event, isMac) && targetInsideEditor) {
                event.preventDefault();
                event.stopPropagation();
                openSearch();
                return;
            }
            if (event.key === 'Escape' &&
                isSearchOpen &&
                (targetInsideEditor || target === searchInputRef.current)) {
                event.preventDefault();
                event.stopPropagation();
                closeSearch();
            }
        };
        window.addEventListener('keydown', handleKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
    }, [closeSearch, isMac, isSearchOpen, openSearch, rootRef]);
    return {
        activeMatchIndex,
        closeSearch,
        isSearchOpen,
        matchCount,
        moveToMatch,
        openSearch,
        searchInputRef,
        searchQuery,
        setSearchQuery
    };
}
