import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/* eslint-disable max-lines */
import React, { useEffect, useCallback, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal';
import { useAppStore } from '../store';
import { findWorktreeById } from '../store/slices/worktree-helpers';
import { createUntitledMarkdownFile } from '../lib/create-untitled-markdown';
import { extractIpcErrorMessage } from '../lib/ipc-error';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import TabBar from './tab-bar/TabBar';
import TerminalPane from './terminal-pane/TerminalPane';
import { ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, requestEditorSaveQuiesce } from './editor/editor-autosave';
import { isUpdaterQuitAndInstallInProgress } from '@/lib/updater-beforeunload';
import EditorAutosaveController from './editor/EditorAutosaveController';
import BrowserPane, { destroyPersistentWebview } from './browser-pane/BrowserPane';
import { reconcileTabOrder } from './tab-bar/reconcile-order';
import TabGroupSplitLayout from './tab-group/TabGroupSplitLayout';
import { shouldAutoCreateInitialTerminal } from './terminal/initial-terminal';
import { getEffectiveLayoutForWorktree as getEffectiveLayout, anyMountedWorktreeHasLayout as computeAnyMountedWorktreeHasLayout } from './terminal/split-group-mount';
import CodexRestartChip from './CodexRestartChip';
const EditorPanel = lazy(() => import('./editor/EditorPanel'));
function Terminal() {
    const activeWorktreeId = useAppStore((s) => s.activeWorktreeId);
    const activeView = useAppStore((s) => s.activeView);
    const worktreesByRepo = useAppStore((s) => s.worktreesByRepo);
    const tabsByWorktree = useAppStore((s) => s.tabsByWorktree);
    const activeTabId = useAppStore((s) => s.activeTabId);
    const createTab = useAppStore((s) => s.createTab);
    const closeTab = useAppStore((s) => s.closeTab);
    const setActiveTab = useAppStore((s) => s.setActiveTab);
    const setActiveWorktree = useAppStore((s) => s.setActiveWorktree);
    const setTabCustomTitle = useAppStore((s) => s.setTabCustomTitle);
    const setTabColor = useAppStore((s) => s.setTabColor);
    const consumeSuppressedPtyExit = useAppStore((s) => s.consumeSuppressedPtyExit);
    const expandedPaneByTabId = useAppStore((s) => s.expandedPaneByTabId);
    const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady);
    const openFiles = useAppStore((s) => s.openFiles);
    const activeFileId = useAppStore((s) => s.activeFileId);
    const activeBrowserTabId = useAppStore((s) => s.activeBrowserTabId);
    const activeTabType = useAppStore((s) => s.activeTabType);
    const setActiveTabType = useAppStore((s) => s.setActiveTabType);
    const setActiveFile = useAppStore((s) => s.setActiveFile);
    const openFile = useAppStore((s) => s.openFile);
    const closeFile = useAppStore((s) => s.closeFile);
    const closeAllFiles = useAppStore((s) => s.closeAllFiles);
    const pinFile = useAppStore((s) => s.pinFile);
    const browserTabsByWorktree = useAppStore((s) => s.browserTabsByWorktree);
    const createBrowserTab = useAppStore((s) => s.createBrowserTab);
    const closeBrowserTab = useAppStore((s) => s.closeBrowserTab);
    const setActiveBrowserTab = useAppStore((s) => s.setActiveBrowserTab);
    const groupsByWorktree = useAppStore((s) => s.groupsByWorktree);
    const layoutByWorktree = useAppStore((s) => s.layoutByWorktree);
    const activeGroupIdByWorktree = useAppStore((s) => s.activeGroupIdByWorktree);
    const ensureWorktreeRootGroup = useAppStore((s) => s.ensureWorktreeRootGroup);
    const reconcileWorktreeTabModel = useAppStore((s) => s.reconcileWorktreeTabModel);
    const markFileDirty = useAppStore((s) => s.markFileDirty);
    const setTabBarOrder = useAppStore((s) => s.setTabBarOrder);
    const tabBarOrderByWorktree = useAppStore((s) => s.tabBarOrderByWorktree);
    const tabBarOrder = activeWorktreeId ? tabBarOrderByWorktree[activeWorktreeId] : undefined;
    const tabs = useMemo(() => (activeWorktreeId ? (tabsByWorktree[activeWorktreeId] ?? []) : []), [activeWorktreeId, tabsByWorktree]);
    const allWorktrees = Object.values(worktreesByRepo).flat();
    // Why: the TabBar is rendered into the titlebar via a portal so tabs share
    // the same row as the "Orca" title. The target element is created by App.tsx.
    // Uses useEffect because the DOM element doesn't exist during the render phase.
    const [titlebarTabsTarget, setTitlebarTabsTarget] = useState(null);
    useEffect(() => {
        setTitlebarTabsTarget(document.getElementById('titlebar-tabs'));
    }, []);
    useEffect(() => {
        if (!activeWorktreeId) {
            return;
        }
        // Why: split-group ownership is now the real path. Ensure the active
        // worktree always has a root group so terminal-first fallback can attach
        // fresh tabs to a concrete owner even before any explicit split exists.
        ensureWorktreeRootGroup(activeWorktreeId);
    }, [activeWorktreeId, ensureWorktreeRootGroup]);
    // Filter editor files to only show those belonging to the active worktree
    const worktreeFiles = activeWorktreeId
        ? openFiles.filter((f) => f.worktreeId === activeWorktreeId)
        : [];
    const worktreeBrowserTabs = activeWorktreeId
        ? (browserTabsByWorktree[activeWorktreeId] ?? [])
        : [];
    const getEffectiveLayoutForWorktree = useCallback((worktreeId) => getEffectiveLayout(worktreeId, layoutByWorktree, groupsByWorktree, activeGroupIdByWorktree), [activeGroupIdByWorktree, groupsByWorktree, layoutByWorktree]);
    const effectiveActiveLayout = activeWorktreeId
        ? getEffectiveLayoutForWorktree(activeWorktreeId)
        : undefined;
    const activeWorktreeBrowserTabIdsKey = activeWorktreeId
        ? (browserTabsByWorktree[activeWorktreeId] ?? []).map((tab) => tab.id).join(',')
        : '';
    // Save confirmation dialog state
    const [saveDialogFileId, setSaveDialogFileId] = useState(null);
    const saveDialogFile = saveDialogFileId ? openFiles.find((f) => f.id === saveDialogFileId) : null;
    // Window close confirmation dialog — shown when the user tries to close the
    // window (X button, Cmd+Q) while terminals with running processes exist.
    const [windowCloseDialogOpen, setWindowCloseDialogOpen] = useState(false);
    const handleCloseFile = useCallback((fileId) => {
        const file = useAppStore.getState().openFiles.find((f) => f.id === fileId);
        if (file?.isDirty) {
            setSaveDialogFileId(fileId);
            return;
        }
        closeFile(fileId);
    }, [closeFile]);
    const handleSaveDialogSave = useCallback(async () => {
        if (!saveDialogFileId) {
            return;
        }
        const file = useAppStore.getState().openFiles.find((f) => f.id === saveDialogFileId);
        if (!file) {
            return;
        }
        // Why: save-and-close must flush the latest draft even when the visible
        // editor panel has already unmounted. The headless autosave controller
        // owns that write path now, so the dialog signals it through a custom
        // event instead of poking at editor component refs.
        window.dispatchEvent(new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail: { fileId: saveDialogFileId } }));
        setSaveDialogFileId(null);
    }, [saveDialogFileId]);
    const handleSaveDialogDiscard = useCallback(async () => {
        if (!saveDialogFileId) {
            return;
        }
        // Why: autosave runs on a background timer. Wait for any pending/in-flight
        // write to settle before honoring "Don't Save", otherwise the file can be
        // written after the user explicitly chose to discard their edits.
        await requestEditorSaveQuiesce({ fileId: saveDialogFileId });
        markFileDirty(saveDialogFileId, false);
        closeFile(saveDialogFileId);
        setSaveDialogFileId(null);
    }, [saveDialogFileId, closeFile, markFileDirty]);
    const handleSaveDialogCancel = useCallback(() => {
        setSaveDialogFileId(null);
    }, []);
    useEffect(() => {
        if (tabs.length === 0) {
            return;
        }
        if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) {
            return;
        }
        // Why: mutating Zustand during render trips React's "Cannot update a
        // component while rendering a different component" warning. Keep the
        // legacy active-tab repair, but run it as an effect after the render that
        // observed the stale activeTabId.
        setActiveTab(tabs[0].id);
    }, [activeTabId, setActiveTab, tabs]);
    // Track which worktrees have been activated during this app session.
    // Only mount TerminalPanes for visited worktrees to prevent mass PTY
    // spawning when restoring a session with many saved worktree tabs.
    const mountedWorktreeIdsRef = useRef(new Set());
    // Why: gated on workspaceSessionReady to prevent TerminalPane from mounting
    // before reconnectPersistedTerminals() has finished eagerly spawning PTYs.
    // Without this gate, Phase 1 (hydrateWorkspaceSession) sets activeWorktreeId
    // with ptyId: null, and TerminalPane would call connectPanePty → pty:spawn,
    // creating a duplicate PTY for the same tab.
    if (activeWorktreeId && workspaceSessionReady) {
        mountedWorktreeIdsRef.current.add(activeWorktreeId);
    }
    // Prune IDs of worktrees that no longer exist (deleted/removed)
    const allWorktreeIds = new Set(allWorktrees.map((wt) => wt.id));
    for (const id of mountedWorktreeIdsRef.current) {
        if (!allWorktreeIds.has(id)) {
            mountedWorktreeIdsRef.current.delete(id);
        }
    }
    const anyMountedWorktreeHasLayout = computeAnyMountedWorktreeHasLayout(allWorktrees.map((wt) => wt.id), mountedWorktreeIdsRef.current, layoutByWorktree, groupsByWorktree, activeGroupIdByWorktree);
    // Auto-create first tab when worktree activates
    useEffect(() => {
        if (!workspaceSessionReady) {
            return;
        }
        if (!activeWorktreeId) {
            return;
        }
        // Why: this fallback exists to give a newly activated/restored worktree a
        // focusable surface when the reconciled tab model has nothing renderable.
        // Re-running it on ordinary tab-count changes would recreate a terminal
        // immediately after the user intentionally closed the last visible one.
        const { renderableTabCount } = reconcileWorktreeTabModel(activeWorktreeId);
        if (!shouldAutoCreateInitialTerminal(renderableTabCount)) {
            return;
        }
        createTab(activeWorktreeId);
    }, [workspaceSessionReady, activeWorktreeId, createTab, reconcileWorktreeTabModel]);
    const handleNewTab = useCallback(() => {
        if (!activeWorktreeId) {
            return;
        }
        const newTab = createTab(activeWorktreeId);
        setActiveTabType('terminal');
        // Why: persist the tab bar order with the new terminal at the end of the
        // current visual order. Without this, reconcileOrder falls back to
        // terminals-first when tabBarOrderByWorktree is unset, causing a new
        // terminal to jump to index 0 instead of appending after editor tabs.
        const state = useAppStore.getState();
        const currentTerminals = state.tabsByWorktree[activeWorktreeId] ?? [];
        const currentEditors = state.openFiles.filter((f) => f.worktreeId === activeWorktreeId);
        const currentBrowsers = state.browserTabsByWorktree[activeWorktreeId] ?? [];
        const stored = state.tabBarOrderByWorktree[activeWorktreeId];
        const termIds = currentTerminals.map((t) => t.id);
        const editorIds = currentEditors.map((f) => f.id);
        const browserIds = currentBrowsers.map((tab) => tab.id);
        const validIds = new Set([...termIds, ...editorIds, ...browserIds]);
        const base = (stored ?? []).filter((id) => validIds.has(id));
        const inBase = new Set(base);
        for (const id of [...termIds, ...editorIds, ...browserIds]) {
            if (!inBase.has(id)) {
                base.push(id);
                inBase.add(id);
            }
        }
        // The new tab is already in base via termIds; move it to the end
        const order = base.filter((id) => id !== newTab.id);
        order.push(newTab.id);
        setTabBarOrder(activeWorktreeId, order);
    }, [activeWorktreeId, createTab, setActiveTabType, setTabBarOrder]);
    const handleNewBrowserTab = useCallback(() => {
        if (!activeWorktreeId) {
            return;
        }
        const defaultUrl = useAppStore.getState().browserDefaultUrl ?? 'about:blank';
        createBrowserTab(activeWorktreeId, defaultUrl, { title: 'New Browser Tab' });
    }, [activeWorktreeId, createBrowserTab]);
    const handleNewFile = useCallback(async () => {
        if (!activeWorktreeId) {
            return;
        }
        const worktree = findWorktreeById(useAppStore.getState().worktreesByRepo, activeWorktreeId);
        if (!worktree) {
            return;
        }
        try {
            // Why: the global Cmd/Ctrl+Shift+M shortcut is handled here rather than
            // inside a specific TabGroupPanel, so it must snapshot the store's
            // current focused group explicitly. Otherwise split layouts fall back to
            // the ambient/default group and open the file in the wrong pane.
            const targetGroupId = useAppStore.getState().activeGroupIdByWorktree[activeWorktreeId];
            const fileInfo = await createUntitledMarkdownFile(worktree.path, activeWorktreeId);
            openFile(fileInfo, { preview: false, targetGroupId });
        }
        catch (err) {
            toast.error(extractIpcErrorMessage(err, 'Failed to create untitled markdown file.'));
        }
    }, [activeWorktreeId, openFile]);
    const handleCloseTab = useCallback((tabId) => {
        const state = useAppStore.getState();
        const owningWorktreeEntry = Object.entries(state.tabsByWorktree).find(([, worktreeTabs]) => worktreeTabs.some((tab) => tab.id === tabId));
        const owningWorktreeId = owningWorktreeEntry?.[0] ?? null;
        if (!owningWorktreeId) {
            return;
        }
        const currentTabs = state.tabsByWorktree[owningWorktreeId] ?? [];
        if (currentTabs.length <= 1) {
            closeTab(tabId);
            if (state.activeWorktreeId === owningWorktreeId) {
                // Why: only deactivate the worktree when no tabs of any kind remain.
                // Editor files are a separate tab type; closing the last terminal tab
                // should switch to the editor view instead of tearing down the workspace.
                const worktreeFile = state.openFiles.find((f) => f.worktreeId === owningWorktreeId);
                if (worktreeFile) {
                    setActiveFile(worktreeFile.id);
                    setActiveTabType('editor');
                }
                else {
                    const browserTab = (state.browserTabsByWorktree[owningWorktreeId] ?? [])[0];
                    if (browserTab) {
                        setActiveBrowserTab(browserTab.id);
                        setActiveTabType('browser');
                    }
                    else {
                        setActiveWorktree(null);
                    }
                }
            }
            return;
        }
        // If closing the active tab in the active worktree, switch to a neighbor.
        if (state.activeWorktreeId === owningWorktreeId && tabId === state.activeTabId) {
            const idx = currentTabs.findIndex((t) => t.id === tabId);
            const nextTab = currentTabs[idx + 1] ?? currentTabs[idx - 1];
            if (nextTab) {
                setActiveTab(nextTab.id);
            }
        }
        closeTab(tabId);
    }, [
        closeTab,
        setActiveBrowserTab,
        setActiveTab,
        setActiveFile,
        setActiveTabType,
        setActiveWorktree
    ]);
    const handleCloseBrowserTab = useCallback((tabId) => {
        const state = useAppStore.getState();
        const owningWorktreeEntry = Object.entries(state.browserTabsByWorktree).find(([, worktreeTabs]) => worktreeTabs.some((tab) => tab.id === tabId));
        const owningWorktreeId = owningWorktreeEntry?.[0] ?? null;
        if (!owningWorktreeId) {
            return;
        }
        const currentTabs = state.browserTabsByWorktree[owningWorktreeId] ?? [];
        if (currentTabs.length <= 1) {
            destroyPersistentWebview(tabId);
            closeBrowserTab(tabId);
            if (state.activeWorktreeId === owningWorktreeId) {
                const worktreeFile = state.openFiles.find((file) => file.worktreeId === owningWorktreeId);
                if (worktreeFile) {
                    setActiveFile(worktreeFile.id);
                    setActiveTabType('editor');
                }
                else {
                    const terminalTab = (state.tabsByWorktree[owningWorktreeId] ?? [])[0];
                    if (terminalTab) {
                        setActiveTab(terminalTab.id);
                        setActiveTabType('terminal');
                    }
                    else {
                        setActiveWorktree(null);
                    }
                }
            }
            return;
        }
        if (state.activeWorktreeId === owningWorktreeId && tabId === state.activeBrowserTabId) {
            const idx = currentTabs.findIndex((tab) => tab.id === tabId);
            const nextTab = currentTabs[idx + 1] ?? currentTabs[idx - 1];
            if (nextTab) {
                setActiveBrowserTab(nextTab.id);
            }
        }
        destroyPersistentWebview(tabId);
        closeBrowserTab(tabId);
    }, [
        closeBrowserTab,
        setActiveBrowserTab,
        setActiveFile,
        setActiveTab,
        setActiveTabType,
        setActiveWorktree
    ]);
    const handlePtyExit = useCallback((tabId, ptyId) => {
        if (consumeSuppressedPtyExit(ptyId)) {
            return;
        }
        handleCloseTab(tabId);
    }, [consumeSuppressedPtyExit, handleCloseTab]);
    const handleCloseOthers = useCallback((tabId) => {
        if (!activeWorktreeId) {
            return;
        }
        const state = useAppStore.getState();
        const order = state.tabBarOrderByWorktree[activeWorktreeId] ?? [];
        for (const id of order) {
            if (id === tabId) {
                continue;
            }
            if ((state.tabsByWorktree[activeWorktreeId] ?? []).some((tab) => tab.id === id)) {
                closeTab(id);
            }
            else if (state.openFiles.some((file) => file.worktreeId === activeWorktreeId && file.id === id)) {
                if (state.activeFileId === id &&
                    state.openFiles.find((file) => file.id === id)?.isDirty) {
                    continue;
                }
                closeFile(id);
            }
            else if ((state.browserTabsByWorktree[activeWorktreeId] ?? []).some((tab) => tab.id === id)) {
                destroyPersistentWebview(id);
                closeBrowserTab(id);
            }
        }
    }, [activeWorktreeId, closeBrowserTab, closeFile, closeTab]);
    const handleCloseTabsToRight = useCallback((tabId) => {
        if (!activeWorktreeId) {
            return;
        }
        const state = useAppStore.getState();
        const currentOrder = state.tabBarOrderByWorktree[activeWorktreeId] ?? [];
        const index = currentOrder.findIndex((id) => id === tabId);
        if (index === -1) {
            return;
        }
        const rightIds = currentOrder.slice(index + 1);
        for (const id of rightIds) {
            if ((state.tabsByWorktree[activeWorktreeId] ?? []).some((tab) => tab.id === id)) {
                closeTab(id);
            }
            else if (state.openFiles.some((file) => file.worktreeId === activeWorktreeId && file.id === id)) {
                closeFile(id);
            }
            else if ((state.browserTabsByWorktree[activeWorktreeId] ?? []).some((tab) => tab.id === id)) {
                destroyPersistentWebview(id);
                closeBrowserTab(id);
            }
        }
    }, [activeWorktreeId, closeBrowserTab, closeFile, closeTab]);
    const handleActivateTab = useCallback((tabId) => {
        setActiveTab(tabId);
        setActiveTabType('terminal');
    }, [setActiveTab, setActiveTabType]);
    const handleTogglePaneExpand = useCallback((tabId) => {
        setActiveTab(tabId);
        requestAnimationFrame(() => {
            window.dispatchEvent(new CustomEvent(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, {
                detail: { tabId }
            }));
        });
    }, [setActiveTab]);
    const handleActivateBrowserTab = useCallback((tabId) => {
        setActiveBrowserTab(tabId);
        setActiveTabType('browser');
    }, [setActiveBrowserTab, setActiveTabType]);
    // Keyboard shortcuts
    useEffect(() => {
        if (!activeWorktreeId) {
            return;
        }
        const isMac = navigator.userAgent.includes('Mac');
        const onKeyDown = (e) => {
            const mod = isMac ? e.metaKey : e.ctrlKey;
            // Why: when the browser workspace is the active surface, standard
            // browser tab creation should stay inside that workspace. Reusing the
            // same shortcut keeps Orca's embedded browser aligned with user
            // expectations instead of unexpectedly mutating the outer tab strip.
            if (mod && e.key === 't' && !e.shiftKey && !e.repeat) {
                e.preventDefault();
                const state = useAppStore.getState();
                if (state.activeTabType === 'browser') {
                    handleNewBrowserTab();
                }
                else {
                    handleNewTab();
                }
                return;
            }
            // Cmd/Ctrl+Shift+T — reopen closed browser tab when browser is active,
            // otherwise reopen the most recently closed editor tab (VS Code–style).
            if (mod && e.shiftKey && e.key.toLowerCase() === 't' && !e.repeat) {
                e.preventDefault();
                const state = useAppStore.getState();
                if (state.activeTabType === 'browser') {
                    const restored = state.reopenClosedBrowserTab(activeWorktreeId);
                    if (restored === null) {
                        state.reopenClosedEditorTab(activeWorktreeId);
                    }
                }
                else {
                    state.reopenClosedEditorTab(activeWorktreeId);
                }
                return;
            }
            // Cmd/Ctrl+Shift+B - new browser tab
            if (mod && e.shiftKey && e.key.toLowerCase() === 'b' && !e.repeat) {
                e.preventDefault();
                handleNewBrowserTab();
                return;
            }
            // Cmd/Ctrl+S - save active editor file (fallback for when focus is
            // outside the editor content area, e.g. on the tab bar or sidebar).
            // When the editor itself has focus, Monaco/rich-markdown handle Cmd+S
            // internally, so we skip this when the target is editable.
            if (mod && e.key === 's' && !e.shiftKey && !e.repeat) {
                const target = e.target;
                const inEditor = target?.closest('.monaco-editor, [contenteditable]') !== null ||
                    target?.closest('textarea:not(.xterm-helper-textarea), input') !== null;
                if (!inEditor) {
                    const state = useAppStore.getState();
                    if (state.activeTabType === 'editor' && state.activeFileId) {
                        e.preventDefault();
                        window.dispatchEvent(new Event(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT));
                        return;
                    }
                }
            }
            // Cmd/Ctrl+Shift+M - new markdown file
            if (mod && e.shiftKey && e.key.toLowerCase() === 'm' && !e.repeat) {
                e.preventDefault();
                void handleNewFile();
                return;
            }
            // Cmd/Ctrl+W - close active editor tab, browser tab, or terminal pane.
            // Terminal pane/tab close is handled by the pane-level keyboard handler
            // in keyboard-handlers.ts so it can close individual split panes and
            // show a confirmation dialog. We still preventDefault here so Electron
            // doesn't close the window as its default Cmd+W action.
            if (mod && e.key === 'w' && !e.shiftKey && !e.repeat) {
                e.preventDefault();
                const state = useAppStore.getState();
                if (state.activeTabType === 'editor' && state.activeFileId) {
                    handleCloseFile(state.activeFileId);
                }
                else if (state.activeTabType === 'browser' && state.activeBrowserTabId) {
                    closeBrowserTab(state.activeBrowserTabId);
                }
                return;
            }
            // Cmd/Ctrl+Shift+] and Cmd/Ctrl+Shift+[ - switch tabs
            // Why: use e.code instead of e.key because on macOS, Shift+[ reports '{'
            // as the key value (the shifted character), not '['.
            if (mod &&
                e.shiftKey &&
                (e.code === 'BracketRight' || e.code === 'BracketLeft') &&
                !e.repeat) {
                const state = useAppStore.getState();
                const currentTerminalTabs = state.tabsByWorktree[activeWorktreeId] ?? [];
                const currentEditorFiles = state.openFiles.filter((f) => f.worktreeId === activeWorktreeId);
                const currentBrowserTabs = state.browserTabsByWorktree[activeWorktreeId] ?? [];
                const terminalIds = currentTerminalTabs.map((t) => t.id);
                const editorIds = currentEditorFiles.map((f) => f.id);
                const browserIds = currentBrowserTabs.map((t) => t.id);
                // Why: use reconcileTabOrder instead of raw tabBarOrderByWorktree so
                // tab switching works even when the stored order is unset (e.g. for
                // worktrees restored from session whose initial tabs were created
                // without populating tabBarOrderByWorktree).
                const reconciledOrder = reconcileTabOrder(state.tabBarOrderByWorktree[activeWorktreeId], terminalIds, editorIds, browserIds);
                const terminalIdSet = new Set(terminalIds);
                const editorIdSet = new Set(editorIds);
                const browserIdSet = new Set(browserIds);
                const allTabIds = reconciledOrder.map((id) => ({
                    type: terminalIdSet.has(id)
                        ? 'terminal'
                        : editorIdSet.has(id)
                            ? 'editor'
                            : browserIdSet.has(id)
                                ? 'browser'
                                : null,
                    id
                }));
                if (allTabIds.length > 1) {
                    e.preventDefault();
                    const currentId = state.activeTabType === 'editor'
                        ? state.activeFileId
                        : state.activeTabType === 'browser'
                            ? state.activeBrowserTabId
                            : state.activeTabId;
                    const idx = allTabIds.findIndex((t) => t.id === currentId);
                    const dir = e.code === 'BracketRight' ? 1 : -1;
                    const next = allTabIds[(idx + dir + allTabIds.length) % allTabIds.length];
                    if (next.type === 'terminal') {
                        setActiveTab(next.id);
                        state.setActiveTabType('terminal');
                    }
                    else if (next.type === 'browser') {
                        state.setActiveBrowserTab(next.id);
                        state.setActiveTabType('browser');
                    }
                    else {
                        state.setActiveFile(next.id);
                        state.setActiveTabType('editor');
                    }
                }
            }
        };
        window.addEventListener('keydown', onKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
    }, [
        activeWorktreeId,
        handleNewBrowserTab,
        handleNewFile,
        handleNewTab,
        handleCloseTab,
        handleCloseBrowserTab,
        closeBrowserTab,
        handleCloseFile,
        setActiveTab
    ]);
    // Warn on window close if there are unsaved editor files
    useEffect(() => {
        const handler = (e) => {
            // Why: updater restarts intentionally close the app even if a hidden
            // editor tab still reports dirty. Let ShipIt replace the bundle instead
            // of vetoing quitAndInstall and leaving the old version running.
            if (isUpdaterQuitAndInstallInProgress()) {
                return;
            }
            const dirtyFiles = useAppStore.getState().openFiles.filter((f) => f.isDirty);
            if (dirtyFiles.length > 0) {
                e.preventDefault();
            }
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, []);
    // Listen for main-process window close requests. When any terminal has a
    // child process running (not just an idle shell), show a confirmation dialog.
    useEffect(() => {
        return window.api.ui.onWindowCloseRequested(({ isQuitting }) => {
            if (isUpdaterQuitAndInstallInProgress()) {
                window.api.ui.confirmWindowClose();
                return;
            }
            // Why: capture terminal scrollback buffers while TerminalPane components
            // are still mounted. Dispatching beforeunload triggers the App.tsx
            // captureAndFlush handler which serializes each pane's xterm buffer
            // and writes the session to disk via synchronous IPC.
            window.dispatchEvent(new Event('beforeunload'));
            // Why: during a quit (Cmd+Q), PTYs are still alive (cleanup is deferred
            // to will-quit so buffers can be captured first). Skip the child-process
            // confirmation dialog and proceed directly — the user's intent to quit
            // is unambiguous.
            if (isQuitting) {
                window.api.ui.confirmWindowClose();
                return;
            }
            const state = useAppStore.getState();
            const allPtyIds = Object.values(state.ptyIdsByTabId).flat();
            if (allPtyIds.length === 0) {
                window.api.ui.confirmWindowClose();
                return;
            }
            void Promise.all(allPtyIds.map((id) => window.api.pty.hasChildProcesses(id))).then((results) => {
                if (results.some(Boolean)) {
                    setWindowCloseDialogOpen(true);
                }
                else {
                    window.api.ui.confirmWindowClose();
                }
            });
        });
    }, []);
    // Why: removeWorktree cleans up browser tab state in the store but cannot
    // call destroyPersistentWebview (renderer-only DOM code). This subscriber
    // detects when browser tabs disappear from a worktree (e.g. worktree deleted)
    // and destroys orphaned webview elements to prevent memory leaks.
    const prevBrowserTabIdsRef = useRef(new Set());
    useEffect(() => {
        let prevBrowserTabs = useAppStore.getState().browserTabsByWorktree;
        return useAppStore.subscribe((state) => {
            if (state.browserTabsByWorktree === prevBrowserTabs) {
                return;
            }
            prevBrowserTabs = state.browserTabsByWorktree;
            const currentIds = new Set(Object.values(state.browserTabsByWorktree)
                .flat()
                .map((tab) => tab.id));
            for (const prevId of prevBrowserTabIdsRef.current) {
                if (!currentIds.has(prevId)) {
                    destroyPersistentWebview(prevId);
                }
            }
            prevBrowserTabIdsRef.current = currentIds;
        });
    }, []);
    // Why: defensive guard against state inconsistency. If activeTabType is
    // 'browser' but no browser tab can be rendered (e.g. activeBrowserTabId is
    // null or doesn't match any tab), fall back to terminal view instead of
    // rendering a blank screen. This runs as an effect (not during render)
    // because calling Zustand mutations during render interferes with React's
    // render cycle and causes blank screens when creating new tabs.
    useEffect(() => {
        const activeWorktreeBrowserTabs = activeWorktreeId
            ? (useAppStore.getState().browserTabsByWorktree[activeWorktreeId] ?? [])
            : [];
        if (activeTabType === 'browser' &&
            activeWorktreeId &&
            (!activeBrowserTabId ||
                !activeWorktreeBrowserTabs.some((tab) => tab.id === activeBrowserTabId))) {
            const fallbackBrowserTab = activeWorktreeBrowserTabs[0];
            if (fallbackBrowserTab) {
                setActiveBrowserTab(fallbackBrowserTab.id);
            }
            else {
                setActiveTabType('terminal');
            }
        }
    }, [
        activeTabType,
        activeWorktreeId,
        activeBrowserTabId,
        activeWorktreeBrowserTabIdsKey,
        setActiveBrowserTab,
        setActiveTabType
    ]);
    return (_jsxs("div", { className: `flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden${activeWorktreeId ? '' : ' hidden'}`, children: [_jsx(EditorAutosaveController, {}), activeWorktreeId &&
                !effectiveActiveLayout &&
                titlebarTabsTarget &&
                createPortal(_jsx(TabBar, { tabs: tabs, activeTabId: activeTabId, worktreeId: activeWorktreeId, onActivate: handleActivateTab, onClose: handleCloseTab, onCloseOthers: handleCloseOthers, onCloseToRight: handleCloseTabsToRight, onNewTerminalTab: handleNewTab, onNewBrowserTab: handleNewBrowserTab, onNewFileTab: handleNewFile, onSetCustomTitle: setTabCustomTitle, onSetTabColor: setTabColor, expandedPaneByTabId: expandedPaneByTabId, onTogglePaneExpand: handleTogglePaneExpand, editorFiles: worktreeFiles, browserTabs: worktreeBrowserTabs, activeFileId: activeFileId, activeBrowserTabId: activeBrowserTabId, activeTabType: activeTabType, onActivateFile: (fileId) => {
                        setActiveFile(fileId);
                        setActiveTabType('editor');
                    }, onCloseFile: handleCloseFile, onActivateBrowserTab: handleActivateBrowserTab, onCloseBrowserTab: handleCloseBrowserTab, onCloseAllFiles: closeAllFiles, onPinFile: pinFile, tabBarOrder: tabBarOrder }), titlebarTabsTarget), anyMountedWorktreeHasLayout ? (_jsx("div", { className: `relative flex flex-1 min-w-0 min-h-0 overflow-hidden${effectiveActiveLayout ? '' : ' hidden'}`, children: allWorktrees
                    .filter((wt) => mountedWorktreeIdsRef.current.has(wt.id))
                    .map((worktree) => {
                    const layout = getEffectiveLayoutForWorktree(worktree.id);
                    if (!layout) {
                        return null;
                    }
                    // Why: use strict equality with 'terminal' instead of !== 'settings'
                    // so the terminal/browser surface hides on the new-workspace page too.
                    const isVisible = activeView === 'terminal' && worktree.id === activeWorktreeId;
                    return (_jsxs("div", { className: isVisible ? 'absolute inset-0 flex' : 'absolute inset-0 hidden', "aria-hidden": !isVisible, children: [_jsx(CodexRestartChip, { worktreeId: worktree.id }), _jsx(TabGroupSplitLayout, { layout: layout, worktreeId: worktree.id, focusedGroupId: activeGroupIdByWorktree[worktree.id], isWorktreeActive: isVisible })] }, `tab-groups-${worktree.id}`));
                }) })) : null, !effectiveActiveLayout && (_jsxs(_Fragment, { children: [_jsx("div", { className: `relative flex-1 min-h-0 overflow-hidden ${
                        // Why: only hide the terminal container when another tab type has
                        // content to display. Hiding unconditionally for non-terminal types
                        // causes a blank screen when activeTabType is stale (e.g. 'editor'
                        // with no files after session restore). The terminal stays visible
                        // as a fallback until another surface is ready.
                        (activeTabType === 'editor' && worktreeFiles.length > 0) ||
                            (activeTabType === 'browser' && worktreeBrowserTabs.length > 0)
                            ? 'hidden'
                            : ''}`, children: allWorktrees
                            .filter((wt) => mountedWorktreeIdsRef.current.has(wt.id))
                            .map((worktree) => {
                            // Why: use strict equality with 'terminal' instead of !== 'settings'
                            // so the terminal/browser surface hides on the new-workspace page too.
                            const isVisible = activeView === 'terminal' && worktree.id === activeWorktreeId;
                            return (_jsxs("div", { className: isVisible ? 'absolute inset-0' : 'absolute inset-0 hidden', "aria-hidden": !isVisible, children: [_jsx(CodexRestartChip, { worktreeId: worktree.id }), (tabsByWorktree[worktree.id] ?? []).map((tab) => (_jsx(TerminalPane, { tabId: tab.id, worktreeId: worktree.id, cwd: worktree.path, isActive: isVisible && tab.id === activeTabId && activeTabType === 'terminal', 
                                        // Why: the bootstrap fallback still uses the legacy
                                        // workspace-level terminal host, where only the active
                                        // tab should render. Keeping `isVisible` explicit avoids
                                        // multiple panes stacking during the short window before
                                        // the split-group root layout is ready.
                                        isVisible: isVisible && tab.id === activeTabId && activeTabType === 'terminal', onPtyExit: (ptyId) => handlePtyExit(tab.id, ptyId), onCloseTab: () => handleCloseTab(tab.id) }, `${tab.id}-${tab.generation ?? 0}`)))] }, worktree.id));
                        }) }), _jsx("div", { className: `relative flex-1 min-h-0 overflow-hidden ${activeTabType !== 'browser' ? 'hidden' : ''}`, children: allWorktrees.map((worktree) => {
                            const browserTabs = browserTabsByWorktree[worktree.id] ?? [];
                            // Why: use strict equality with 'terminal' instead of !== 'settings'
                            // so browser panes also hide on the new-workspace page.
                            const isVisibleWorktree = activeView === 'terminal' && worktree.id === activeWorktreeId;
                            if (browserTabs.length === 0) {
                                return null;
                            }
                            return (_jsx("div", { className: isVisibleWorktree ? 'absolute inset-0' : 'absolute inset-0 hidden', "aria-hidden": !isVisibleWorktree, children: browserTabs.map((browserTab) => {
                                    const isBrowserActive = isVisibleWorktree &&
                                        activeTabType === 'browser' &&
                                        browserTab.id === activeBrowserTabId;
                                    return (_jsx("div", { className: `absolute inset-0${isBrowserActive ? '' : ' pointer-events-none hidden'}`, children: _jsx(BrowserPane, { browserTab: browserTab, isActive: isBrowserActive }) }, browserTab.id));
                                }) }, `browser-${worktree.id}`));
                        }) }), activeWorktreeId && activeTabType === 'editor' && worktreeFiles.length > 0 && (_jsx(Suspense, { fallback: _jsx("div", { className: "flex-1 flex items-center justify-center text-muted-foreground text-sm", children: "Loading editor..." }), children: _jsx(EditorPanel, {}) }))] })), _jsx(Dialog, { open: saveDialogFileId !== null, onOpenChange: (open) => {
                    if (!open) {
                        handleSaveDialogCancel();
                    }
                }, children: _jsxs(DialogContent, { className: "max-w-sm", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { className: "text-sm", children: "Unsaved Changes" }), _jsx(DialogDescription, { className: "text-xs", children: saveDialogFile
                                        ? `"${saveDialogFile.relativePath.split('/').pop()}" has unsaved changes. Do you want to save before closing?`
                                        : 'This file has unsaved changes.' })] }), _jsxs(DialogFooter, { className: "gap-2", children: [_jsx(Button, { type: "button", variant: "outline", size: "sm", onClick: handleSaveDialogCancel, children: "Cancel" }), _jsx(Button, { type: "button", variant: "outline", size: "sm", onClick: handleSaveDialogDiscard, children: "Don't Save" }), _jsx(Button, { type: "button", size: "sm", onClick: handleSaveDialogSave, children: "Save" })] })] }) }), _jsx(Dialog, { open: windowCloseDialogOpen, onOpenChange: (open) => {
                    if (!open) {
                        setWindowCloseDialogOpen(false);
                    }
                }, children: _jsxs(DialogContent, { className: "max-w-sm", showCloseButton: false, children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { className: "text-sm", children: "Close Window?" }), _jsx(DialogDescription, { className: "text-xs", children: "There are terminals with running processes. If you close the window, those processes will be killed." })] }), _jsxs(DialogFooter, { className: "gap-2", children: [_jsx(Button, { type: "button", variant: "outline", size: "sm", onClick: () => setWindowCloseDialogOpen(false), children: "Cancel" }), _jsx(Button, { type: "button", variant: "destructive", size: "sm", autoFocus: true, onClick: () => {
                                        setWindowCloseDialogOpen(false);
                                        window.api.ui.confirmWindowClose();
                                    }, children: "Close" })] })] }) })] }));
}
export default React.memo(Terminal);
