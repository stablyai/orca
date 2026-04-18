import type { PaneManager } from '@/lib/pane-manager/pane-manager';
import type { AppState } from '@/store/types';
type RegisteredTerminalTab = {
    tabId: string;
    worktreeId: string;
    getManager: () => PaneManager | null;
    getContainer: () => HTMLDivElement | null;
    getPtyIdForPane: (paneId: number) => string | null;
};
export declare function setRuntimeGraphStoreStateGetter(getter: (() => AppState) | null): void;
export declare function registerRuntimeTerminalTab(tab: RegisteredTerminalTab): () => void;
export declare function setRuntimeGraphSyncEnabled(enabled: boolean): void;
export declare function scheduleRuntimeGraphSync(): void;
export {};
