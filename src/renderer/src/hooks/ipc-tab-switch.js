import { useAppStore } from '../store';
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order';
/**
 * Handle Cmd/Ctrl+Tab direction switching across terminal, editor, and browser tabs.
 * Extracted from useIpcEvents to keep file size under the max-lines lint threshold.
 */
export function handleSwitchTab(direction) {
    const store = useAppStore.getState();
    const worktreeId = store.activeWorktreeId;
    if (!worktreeId) {
        return;
    }
    const terminalTabs = store.tabsByWorktree[worktreeId] ?? [];
    const editorFiles = store.openFiles.filter((f) => f.worktreeId === worktreeId);
    const browserTabs = store.browserTabsByWorktree[worktreeId] ?? [];
    const terminalIds = terminalTabs.map((t) => t.id);
    const editorIds = editorFiles.map((f) => f.id);
    const browserIds = browserTabs.map((t) => t.id);
    const reconciledOrder = reconcileTabOrder(store.tabBarOrderByWorktree[worktreeId], terminalIds, editorIds, browserIds);
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
        const currentId = store.activeTabType === 'editor'
            ? store.activeFileId
            : store.activeTabType === 'browser'
                ? store.activeBrowserTabId
                : store.activeTabId;
        const idx = allTabIds.findIndex((t) => t.id === currentId);
        const next = allTabIds[(idx + direction + allTabIds.length) % allTabIds.length];
        if (next.type === 'terminal') {
            store.setActiveTab(next.id);
            store.setActiveTabType('terminal');
        }
        else if (next.type === 'browser') {
            store.setActiveBrowserTab(next.id);
            store.setActiveTabType('browser');
        }
        else {
            store.setActiveFile(next.id);
            store.setActiveTabType('editor');
        }
    }
}
