import type { Tab, TabContentType, TabGroup, WorkspaceSessionState } from '../../../../shared/types';
export declare function findTabAndWorktree(tabsByWorktree: Record<string, Tab[]>, tabId: string): {
    tab: Tab;
    worktreeId: string;
} | null;
export declare function findGroupForTab(groupsByWorktree: Record<string, TabGroup[]>, worktreeId: string, groupId: string): TabGroup | null;
export declare function findGroupAndWorktree(groupsByWorktree: Record<string, TabGroup[]>, groupId: string): {
    group: TabGroup;
    worktreeId: string;
} | null;
export declare function findTabByEntityInGroup(tabsByWorktree: Record<string, Tab[]>, worktreeId: string, groupId: string, entityId: string, contentType?: Tab['contentType']): Tab | null;
export declare function ensureGroup(groupsByWorktree: Record<string, TabGroup[]>, activeGroupIdByWorktree: Record<string, string>, worktreeId: string, preferredGroupId?: string): {
    group: TabGroup;
    groupsByWorktree: Record<string, TabGroup[]>;
    activeGroupIdByWorktree: Record<string, string>;
};
/** Pick the nearest neighbor in visual order (right first, then left). */
export declare function pickNeighbor(tabOrder: string[], closingTabId: string): string | null;
export declare function updateGroup(groups: TabGroup[], updated: TabGroup): TabGroup[];
export declare function isTransientEditorContentType(contentType: TabContentType): boolean;
export declare function getPersistedEditFileIdsByWorktree(session: WorkspaceSessionState): Record<string, Set<string>>;
export declare function selectHydratedActiveGroupId(groups: TabGroup[], persistedActiveGroupId?: string): string | undefined;
export declare function dedupeTabOrder(tabIds: string[]): string[];
/**
 * Apply a partial update to a single tab, returning the new `unifiedTabsByWorktree`
 * map. Returns `null` if the tab is not found (callers should return `{}` to the
 * zustand setter in that case).
 */
export declare function patchTab(tabsByWorktree: Record<string, Tab[]>, tabId: string, patch: Partial<Tab>): {
    unifiedTabsByWorktree: Record<string, Tab[]>;
} | null;
