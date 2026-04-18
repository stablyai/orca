import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { lazy, Suspense } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { Columns2, Ellipsis, Rows2, X } from 'lucide-react';
import { useAppStore } from '../../store';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import TabBar from '../tab-bar/TabBar';
import TerminalPane from '../terminal-pane/TerminalPane';
import BrowserPane from '../browser-pane/BrowserPane';
import { useTabGroupWorkspaceModel } from './useTabGroupWorkspaceModel';
import TabGroupDropOverlay from './TabGroupDropOverlay';
import { getTabPaneBodyDroppableId } from './useTabDragSplit';
const EditorPanel = lazy(() => import('../editor/EditorPanel'));
export default function TabGroupPanel({ groupId, worktreeId, isFocused, hasSplitGroups, reserveClosedExplorerToggleSpace, reserveCollapsedSidebarHeaderSpace, isTabDragActive = false, activeDropZone = null }) {
    const rightSidebarOpen = useAppStore((state) => state.rightSidebarOpen);
    const sidebarOpen = useAppStore((state) => state.sidebarOpen);
    const model = useTabGroupWorkspaceModel({ groupId, worktreeId });
    const { activeBrowserTab, activeTab, browserItems, commands, editorItems, runtimeTerminalTabById, tabBarOrder, terminalTabs, worktreePath } = model;
    const { setNodeRef: setBodyDropRef } = useDroppable({
        id: getTabPaneBodyDroppableId(groupId),
        data: {
            kind: 'pane-body',
            groupId,
            worktreeId
        },
        disabled: !isTabDragActive
    });
    const tabBar = (_jsx(TabBar, { tabs: terminalTabs, activeTabId: activeTab?.contentType === 'terminal' ? activeTab.entityId : null, groupId: groupId, worktreeId: worktreeId, expandedPaneByTabId: model.expandedPaneByTabId, onActivate: commands.activateTerminal, onClose: (terminalId) => {
            const item = model.groupTabs.find((candidate) => candidate.entityId === terminalId && candidate.contentType === 'terminal');
            if (item) {
                commands.closeItem(item.id);
            }
        }, onCloseOthers: (terminalId) => {
            const item = model.groupTabs.find((candidate) => candidate.entityId === terminalId && candidate.contentType === 'terminal');
            if (item) {
                commands.closeOthers(item.id);
            }
        }, onCloseToRight: (terminalId) => {
            const item = model.groupTabs.find((candidate) => candidate.entityId === terminalId && candidate.contentType === 'terminal');
            if (item) {
                commands.closeToRight(item.id);
            }
        }, onNewTerminalTab: commands.newTerminalTab, onNewBrowserTab: commands.newBrowserTab, onNewFileTab: commands.newFileTab, onSetCustomTitle: commands.setTabCustomTitle, onSetTabColor: commands.setTabColor, onTogglePaneExpand: () => { }, editorFiles: editorItems, browserTabs: browserItems, activeFileId: activeTab?.contentType === 'terminal' || activeTab?.contentType === 'browser'
            ? null
            : activeTab?.id, activeBrowserTabId: activeTab?.contentType === 'browser' ? activeTab.entityId : null, activeTabType: activeTab?.contentType === 'terminal'
            ? 'terminal'
            : activeTab?.contentType === 'browser'
                ? 'browser'
                : 'editor', onActivateFile: commands.activateEditor, onCloseFile: commands.closeItem, onActivateBrowserTab: commands.activateBrowser, onCloseBrowserTab: (browserTabId) => {
            const item = model.groupTabs.find((candidate) => candidate.entityId === browserTabId && candidate.contentType === 'browser');
            if (item) {
                commands.closeItem(item.id);
            }
        }, onCloseAllFiles: commands.closeAllEditorTabsInGroup, onPinFile: (_fileId, tabId) => {
            if (!tabId) {
                return;
            }
            const item = model.groupTabs.find((candidate) => candidate.id === tabId);
            if (!item) {
                return;
            }
            commands.pinFile(item.entityId, item.id);
        }, tabBarOrder: tabBarOrder, onCreateSplitGroup: commands.createSplitGroup }));
    const menuButtonClassName = 'my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
    const actionChromeClassName = `flex shrink-0 items-center overflow-hidden transition-[width,margin,opacity] duration-150 ${isFocused
        ? 'ml-1.5 w-7 pointer-events-auto opacity-100'
        : 'ml-1.5 w-7 pointer-events-none opacity-0'}`;
    return (_jsxs("div", { className: `group/tab-group flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden${hasSplitGroups ? ` border-x border-b ${isFocused ? 'border-accent' : 'border-border'}` : ''}`, onPointerDown: commands.focusGroup, 
        // Why: keyboard and assistive-tech users can move focus into an unfocused
        // split group without generating a pointer event. Keeping the owning
        // group in sync with DOM focus makes global shortcuts like New Markdown
        // target the panel the user actually navigated into.
        onFocusCapture: commands.focusGroup, children: [_jsx("div", { className: "h-[42px] shrink-0 border-b border-border bg-card", children: _jsxs("div", { className: `flex h-full items-stretch pr-1.5${reserveClosedExplorerToggleSpace && !rightSidebarOpen ? ' pr-10' : ''}`, style: {
                        paddingLeft: reserveCollapsedSidebarHeaderSpace && !sidebarOpen
                            ? 'var(--collapsed-sidebar-header-width)'
                            : undefined
                    }, children: [_jsx("div", { className: "min-w-0 flex-1 h-full", children: tabBar }), _jsx("div", { className: actionChromeClassName, style: { WebkitAppRegion: 'no-drag' }, children: isFocused ? (_jsxs(DropdownMenu, { modal: false, children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsx("button", { type: "button", "aria-label": "Pane Actions", title: "Pane Actions", onClick: (event) => {
                                                event.stopPropagation();
                                            }, className: menuButtonClassName, children: _jsx(Ellipsis, { className: "size-4" }) }) }), _jsxs(DropdownMenuContent, { align: "end", side: "bottom", sideOffset: 4, children: [_jsxs(DropdownMenuItem, { onSelect: () => {
                                                    commands.createSplitGroup('right');
                                                }, children: [_jsx(Columns2, { className: "size-4" }), "Split Right"] }), _jsxs(DropdownMenuItem, { onSelect: () => {
                                                    commands.createSplitGroup('down');
                                                }, children: [_jsx(Rows2, { className: "size-4" }), "Split Down"] }), _jsxs(DropdownMenuItem, { onSelect: () => {
                                                    commands.createSplitGroup('left');
                                                }, children: [_jsx(Columns2, { className: "size-4" }), "Split Left"] }), _jsxs(DropdownMenuItem, { onSelect: () => {
                                                    commands.createSplitGroup('up');
                                                }, children: [_jsx(Rows2, { className: "size-4" }), "Split Up"] }), hasSplitGroups ? (_jsxs(_Fragment, { children: [_jsx(DropdownMenuSeparator, {}), _jsxs(DropdownMenuItem, { variant: "destructive", onSelect: () => {
                                                            commands.closeGroup();
                                                        }, children: [_jsx(X, { className: "size-4" }), "Close Group"] })] })) : null] })] })) : null })] }) }), _jsxs("div", { ref: setBodyDropRef, className: "relative flex-1 min-h-0 overflow-hidden", children: [activeDropZone ? _jsx(TabGroupDropOverlay, { zone: activeDropZone }) : null, model.groupTabs
                        .filter((item) => item.contentType === 'terminal')
                        .map((item) => (_jsx(TerminalPane, { tabId: item.entityId, worktreeId: worktreeId, cwd: worktreePath, isActive: isFocused && activeTab?.id === item.id && activeTab.contentType === 'terminal', 
                        // Why: in multi-group splits, the active terminal in each group
                        // must remain visible (display:flex) so the user sees its output,
                        // but only the focused group's terminal should receive keyboard
                        // input. isVisible controls rendering; isActive controls focus.
                        isVisible: activeTab?.id === item.id && activeTab.contentType === 'terminal', onPtyExit: (ptyId) => {
                            if (commands.consumeSuppressedPtyExit(ptyId)) {
                                return;
                            }
                            commands.closeItem(item.id);
                        }, onCloseTab: () => commands.closeItem(item.id) }, `${item.entityId}-${runtimeTerminalTabById.get(item.entityId)?.generation ?? 0}`))), activeTab &&
                        activeTab.contentType !== 'terminal' &&
                        activeTab.contentType !== 'browser' && (_jsx("div", { className: "absolute inset-0 flex min-h-0 min-w-0", children: _jsx(Suspense, { fallback: _jsx("div", { className: "flex flex-1 items-center justify-center text-sm text-muted-foreground", children: "Loading editor..." }), children: _jsx(EditorPanel, { activeFileId: activeTab.entityId, activeViewStateId: activeTab.id }) }) })), browserItems.map((bt) => (_jsx("div", { className: "absolute inset-0 flex min-h-0 min-w-0", style: { display: activeBrowserTab?.id === bt.id ? undefined : 'none' }, children: _jsx(BrowserPane, { browserTab: bt, isActive: activeBrowserTab?.id === bt.id }) }, bt.id)))] })] }));
}
