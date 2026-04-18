import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { FilePlus, Globe, Plus, TerminalSquare } from 'lucide-react';
import { useAppStore } from '../../store';
import { buildStatusMap } from '../right-sidebar/status-display';
import SortableTab from './SortableTab';
import EditorFileTab from './EditorFileTab';
import BrowserTab from './BrowserTab';
import { reconcileTabOrder } from './reconcile-order';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
const isMac = navigator.userAgent.includes('Mac');
const NEW_TERMINAL_SHORTCUT = isMac ? '⌘T' : 'Ctrl+T';
const NEW_BROWSER_SHORTCUT = isMac ? '⌘⇧B' : 'Ctrl+Shift+B';
const NEW_FILE_SHORTCUT = isMac ? '⌘⇧M' : 'Ctrl+Shift+M';
function TabBarInner({ tabs, activeTabId, groupId, worktreeId, expandedPaneByTabId, onActivate, onClose, onCloseOthers, onCloseToRight, onNewTerminalTab, onNewBrowserTab, onNewFileTab, onSetCustomTitle, onSetTabColor, onTogglePaneExpand, editorFiles, browserTabs, activeFileId, activeBrowserTabId, activeTabType, onActivateFile, onCloseFile, onActivateBrowserTab, onCloseBrowserTab, onCloseAllFiles, onPinFile, tabBarOrder, onCreateSplitGroup }) {
    const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree);
    const resolvedGroupId = groupId ?? worktreeId;
    const statusByRelativePath = useMemo(() => buildStatusMap(gitStatusByWorktree[worktreeId] ?? []), [worktreeId, gitStatusByWorktree]);
    const terminalMap = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs]);
    const editorMap = useMemo(() => new Map((editorFiles ?? []).map((f) => [f.tabId ?? f.id, f])), [editorFiles]);
    const browserMap = useMemo(() => new Map((browserTabs ?? []).map((t) => [t.id, t])), [browserTabs]);
    const terminalIds = useMemo(() => tabs.map((t) => t.id), [tabs]);
    const editorFileIds = useMemo(() => editorFiles?.map((f) => f.tabId ?? f.id) ?? [], [editorFiles]);
    const browserTabIds = useMemo(() => browserTabs?.map((tab) => tab.id) ?? [], [browserTabs]);
    // Build the unified ordered list, reconciling stored order with current items
    const orderedItems = useMemo(() => {
        const ids = reconcileTabOrder(tabBarOrder, terminalIds, editorFileIds, browserTabIds);
        const items = [];
        for (const id of ids) {
            const terminal = terminalMap.get(id);
            if (terminal) {
                items.push({
                    type: 'terminal',
                    id,
                    unifiedTabId: terminal.unifiedTabId ?? terminal.id,
                    data: terminal
                });
                continue;
            }
            const file = editorMap.get(id);
            if (file) {
                items.push({ type: 'editor', id, unifiedTabId: file.tabId ?? file.id, data: file });
                continue;
            }
            const browserTab = browserMap.get(id);
            if (browserTab) {
                items.push({
                    type: 'browser',
                    id,
                    unifiedTabId: browserTab.tabId ?? browserTab.id,
                    data: browserTab
                });
            }
        }
        return items;
    }, [tabBarOrder, terminalIds, editorFileIds, browserTabIds, terminalMap, editorMap, browserMap]);
    const sortableIds = useMemo(() => orderedItems.map((item) => item.id), [orderedItems]);
    const focusTerminalTabSurface = useCallback((tabId) => {
        // Why: creating a terminal from the "+" menu is a two-step focus race:
        // React must first mount the new TerminalPane/xterm, then Radix closes the
        // menu. Even after suppressing trigger focus restore, the terminal's hidden
        // textarea may not exist until the next paint. Double-rAF waits for that
        // commit so the new tab, not the "+" button, ends up owning keyboard focus.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const scoped = document.querySelector(`[data-terminal-tab-id="${tabId}"] .xterm-helper-textarea`);
                if (scoped) {
                    scoped.focus();
                    return;
                }
                const fallback = document.querySelector('.xterm-helper-textarea');
                fallback?.focus();
            });
        });
    }, []);
    // Horizontal wheel scrolling for the tab strip
    const tabStripRef = useRef(null);
    const prevStripLenRef = useRef(null);
    const stickToEndRef = useRef(false);
    useEffect(() => {
        const el = tabStripRef.current;
        if (!el) {
            return;
        }
        const onWheel = (e) => {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                e.preventDefault();
                el.scrollLeft += e.deltaY;
            }
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, []);
    useEffect(() => {
        const el = tabStripRef.current;
        if (!el) {
            return;
        }
        const isAtEnd = () => {
            const max = Math.max(0, el.scrollWidth - el.clientWidth);
            return el.scrollLeft >= max - 2;
        };
        const onScroll = () => {
            // Only keep sticking while the user hasn't intentionally scrolled away.
            stickToEndRef.current = isAtEnd();
        };
        el.addEventListener('scroll', onScroll, { passive: true });
        // Seed based on initial position.
        onScroll();
        const ro = new ResizeObserver(() => {
            // If the user is pinned to the right edge, keep it pinned even as tab
            // labels (e.g. \"Terminal 5\" → branch name) expand and change scrollWidth.
            if (!stickToEndRef.current) {
                return;
            }
            el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
        });
        ro.observe(el);
        return () => {
            el.removeEventListener('scroll', onScroll);
            ro.disconnect();
        };
    }, []);
    // Why: new and reopened tabs are appended to the right; without this the strip
    // keeps its scroll offset and the active tab can sit off-screen until the user
    // drags the tab bar horizontally.
    useLayoutEffect(() => {
        const strip = tabStripRef.current;
        const len = orderedItems.length;
        const prev = prevStripLenRef.current;
        if (!strip) {
            prevStripLenRef.current = { worktreeId, len };
            return;
        }
        if (!prev || prev.worktreeId !== worktreeId) {
            prevStripLenRef.current = { worktreeId, len };
            return;
        }
        // If the user is pinned to the right edge, keep the close button visible
        // even when tab labels change length (e.g. "Terminal 5" → branch name).
        // Why: label changes don't necessarily change the strip element's own size,
        // so ResizeObserver won't fire; this effect runs on rerenders instead.
        if (stickToEndRef.current) {
            const scrollToEnd = () => {
                const el = tabStripRef.current;
                if (!el) {
                    return;
                }
                el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
            };
            scrollToEnd();
            requestAnimationFrame(scrollToEnd);
        }
        if (len > prev.len) {
            const scrollToEnd = () => {
                const el = tabStripRef.current;
                if (!el) {
                    return;
                }
                el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
                stickToEndRef.current = true;
            };
            scrollToEnd();
            requestAnimationFrame(scrollToEnd);
        }
        prevStripLenRef.current = { worktreeId, len };
    }, [orderedItems, worktreeId]);
    return (_jsxs("div", { className: "flex items-stretch h-full overflow-hidden flex-1 min-w-0", "data-native-file-drop-target": "editor", children: [_jsx(SortableContext, { items: sortableIds, strategy: horizontalListSortingStrategy, children: _jsx("div", { ref: tabStripRef, className: "terminal-tab-strip flex items-stretch overflow-x-auto overflow-y-hidden", style: { WebkitAppRegion: 'no-drag' }, children: orderedItems.map((item, index) => {
                        const dragData = {
                            kind: 'tab',
                            worktreeId,
                            groupId: resolvedGroupId,
                            unifiedTabId: item.unifiedTabId,
                            visibleTabId: item.id,
                            tabType: item.type
                        };
                        if (item.type === 'terminal') {
                            return (_jsx(SortableTab, { tab: item.data, tabCount: tabs.length, hasTabsToRight: index < orderedItems.length - 1, isActive: activeTabType === 'terminal' && item.id === activeTabId, isExpanded: expandedPaneByTabId[item.id] === true, onActivate: onActivate, onClose: onClose, onCloseOthers: onCloseOthers, onCloseToRight: onCloseToRight, onSetCustomTitle: onSetCustomTitle, onSetTabColor: onSetTabColor, onToggleExpand: onTogglePaneExpand, onSplitGroup: (direction, sourceVisibleTabId) => onCreateSplitGroup?.(direction, sourceVisibleTabId), dragData: dragData }, item.id));
                        }
                        if (item.type === 'browser') {
                            return (_jsx(BrowserTab, { tab: item.data, isActive: activeTabType === 'browser' && activeBrowserTabId === item.id, hasTabsToRight: index < orderedItems.length - 1, onActivate: () => onActivateBrowserTab?.(item.id), onClose: () => onCloseBrowserTab?.(item.id), onCloseToRight: () => onCloseToRight(item.id), onSplitGroup: (direction, sourceVisibleTabId) => onCreateSplitGroup?.(direction, sourceVisibleTabId), dragData: dragData }, item.id));
                        }
                        return (_jsx(EditorFileTab, { file: item.data, isActive: activeTabType === 'editor' && activeFileId === item.id, hasTabsToRight: index < orderedItems.length - 1, statusByRelativePath: statusByRelativePath, onActivate: () => onActivateFile?.(item.id), onClose: () => onCloseFile?.(item.id), onCloseToRight: () => onCloseToRight(item.id), onCloseAll: () => onCloseAllFiles?.(), onPin: () => onPinFile?.(item.data.id, item.data.tabId), onSplitGroup: (direction, sourceVisibleTabId) => onCreateSplitGroup?.(direction, sourceVisibleTabId), dragData: dragData }, item.id));
                    }) }) }), _jsxs(DropdownMenu, { children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsx("button", { className: "ml-2 my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground", style: { WebkitAppRegion: 'no-drag' }, title: "New tab", children: _jsx(Plus, { className: "w-3.5 h-3.5" }) }) }), _jsxs(DropdownMenuContent, { align: "start", sideOffset: 6, className: "min-w-[11rem] rounded-[11px] border-border/80 p-1 shadow-[0_16px_36px_rgba(0,0,0,0.24)]", onCloseAutoFocus: (e) => {
                            // Why: selecting "New Terminal" activates a freshly-mounted xterm on
                            // the next frame. Radix's default focus restore sends focus back to
                            // the "+" trigger after close, which steals it from the new tab and
                            // makes the terminal look unfocused until the user clicks again.
                            e.preventDefault();
                        }, children: [_jsxs(DropdownMenuItem, { onSelect: () => {
                                    onNewTerminalTab();
                                    const newActiveTabId = useAppStore.getState().activeTabId;
                                    if (newActiveTabId) {
                                        focusTerminalTabSurface(newActiveTabId);
                                    }
                                }, className: "gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium", children: [_jsx(TerminalSquare, { className: "size-4 text-muted-foreground" }), "New Terminal", _jsx(DropdownMenuShortcut, { children: NEW_TERMINAL_SHORTCUT })] }), _jsxs(DropdownMenuItem, { onSelect: onNewBrowserTab, className: "gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium", children: [_jsx(Globe, { className: "size-4 text-muted-foreground" }), "New Browser Tab", _jsx(DropdownMenuShortcut, { children: NEW_BROWSER_SHORTCUT })] }), onNewFileTab && (_jsxs(DropdownMenuItem, { onSelect: onNewFileTab, className: "gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium", children: [_jsx(FilePlus, { className: "size-4 text-muted-foreground" }), "New Markdown", _jsx(DropdownMenuShortcut, { children: NEW_FILE_SHORTCUT })] }))] })] })] }));
}
export default React.memo(TabBarInner);
