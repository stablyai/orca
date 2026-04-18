import { paneLeafId, serializePaneTree } from '@/components/terminal-pane/layout-serialization';
const registeredTabs = new Map();
let syncScheduled = false;
let syncEnabled = false;
let getStoreState = null;
export function setRuntimeGraphStoreStateGetter(getter) {
    getStoreState = getter;
}
export function registerRuntimeTerminalTab(tab) {
    registeredTabs.set(tab.tabId, tab);
    scheduleRuntimeGraphSync();
    return () => {
        registeredTabs.delete(tab.tabId);
        scheduleRuntimeGraphSync();
    };
}
export function setRuntimeGraphSyncEnabled(enabled) {
    syncEnabled = enabled;
    if (enabled) {
        scheduleRuntimeGraphSync();
    }
}
export function scheduleRuntimeGraphSync() {
    if (!syncEnabled || syncScheduled) {
        return;
    }
    syncScheduled = true;
    queueMicrotask(() => {
        syncScheduled = false;
        void syncRuntimeGraph();
    });
}
async function syncRuntimeGraph() {
    if (!syncEnabled || !getStoreState) {
        return;
    }
    // Why: the runtime graph helper cannot import the Zustand store directly
    // because the terminal slice also imports this module to schedule syncs.
    // Injecting the getter from App keeps the runtime graph path out of the
    // store construction cycle and avoids test-time partial initialization.
    const state = getStoreState();
    const graph = {
        tabs: [],
        leaves: []
    };
    for (const [tabId, registeredTab] of registeredTabs) {
        const tab = Object.values(state.tabsByWorktree)
            .flat()
            .find((candidate) => candidate.id === tabId);
        if (!tab) {
            continue;
        }
        const manager = registeredTab.getManager();
        const container = registeredTab.getContainer();
        const activePaneId = manager?.getActivePane()?.id ?? null;
        const root = container?.firstElementChild instanceof HTMLElement ? container.firstElementChild : null;
        graph.tabs.push({
            tabId,
            worktreeId: registeredTab.worktreeId,
            title: tab.customTitle ?? tab.title,
            activeLeafId: activePaneId === null ? null : paneLeafId(activePaneId),
            layout: serializePaneTree(root)
        });
        for (const pane of manager?.getPanes() ?? []) {
            graph.leaves.push({
                tabId,
                worktreeId: registeredTab.worktreeId,
                leafId: paneLeafId(pane.id),
                paneRuntimeId: pane.id,
                ptyId: registeredTab.getPtyIdForPane(pane.id)
            });
        }
    }
    try {
        await window.api.runtime.syncWindowGraph(graph);
    }
    catch (error) {
        console.error('[runtime] Failed to sync renderer graph:', error);
    }
}
