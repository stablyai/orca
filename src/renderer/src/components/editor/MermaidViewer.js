import { jsx as _jsx } from "react/jsx-runtime";
import { useLayoutEffect, useRef } from 'react';
import { useAppStore } from '@/store';
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache';
import MermaidBlock from './MermaidBlock';
// Why: MermaidViewer is the full-file counterpart to MermaidBlock (which
// renders fenced mermaid blocks inside markdown). When a user opens a .mmd
// or .mermaid file in diagram mode, the entire file content is the diagram
// source — no markdown wrapper, no frontmatter, just mermaid syntax.
export default function MermaidViewer({ content, filePath }) {
    const rootRef = useRef(null);
    const settings = useAppStore((s) => s.settings);
    const isDark = settings?.theme === 'dark' ||
        (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    // Why: Each viewing mode (source vs diagram) produces different DOM heights.
    // Mode-scoped keys prevent restoring a source-mode scroll position in diagram
    // mode (same reasoning as MarkdownPreview's scrollCacheKey).
    const scrollCacheKey = `${filePath}:mermaid-diagram`;
    useLayoutEffect(() => {
        const container = rootRef.current;
        if (!container) {
            return;
        }
        let throttleTimer = null;
        const onScroll = () => {
            if (throttleTimer !== null) {
                clearTimeout(throttleTimer);
            }
            throttleTimer = setTimeout(() => {
                setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop);
                throttleTimer = null;
            }, 150);
        };
        container.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            // Why: guard against writing 0 when the SVG has not rendered yet (e.g.,
            // StrictMode double-mount or quick tab switch before mermaid.render()
            // completes). Without this, a valid cached position gets clobbered.
            if (container.scrollHeight > container.clientHeight || container.scrollTop > 0) {
                setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop);
            }
            if (throttleTimer !== null) {
                clearTimeout(throttleTimer);
            }
            container.removeEventListener('scroll', onScroll);
        };
    }, [scrollCacheKey]);
    useLayoutEffect(() => {
        const container = rootRef.current;
        const targetScrollTop = scrollTopCache.get(scrollCacheKey);
        if (!container || targetScrollTop === undefined) {
            return;
        }
        let frameId = 0;
        let attempts = 0;
        // Why: mermaid.render() is async, so the SVG may not exist on the first
        // frame. Retry up to 30 frames (~500ms) to match MarkdownPreview's pattern.
        const tryRestore = () => {
            const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
            const nextScrollTop = Math.min(targetScrollTop, maxScrollTop);
            container.scrollTop = nextScrollTop;
            if (Math.abs(container.scrollTop - targetScrollTop) <= 1 || maxScrollTop >= targetScrollTop) {
                return;
            }
            attempts += 1;
            if (attempts < 30) {
                frameId = window.requestAnimationFrame(tryRestore);
            }
        };
        tryRestore();
        return () => window.cancelAnimationFrame(frameId);
    }, [scrollCacheKey, content]);
    return (_jsx("div", { ref: rootRef, className: "mermaid-viewer h-full min-h-0 overflow-auto scrollbar-editor", children: _jsx("div", { className: "mermaid-viewer-canvas", children: _jsx(MermaidBlock, { content: content.trim(), isDark: isDark, htmlLabels: false }) }) }));
}
