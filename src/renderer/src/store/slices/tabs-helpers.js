export function findTabAndWorktree(tabsByWorktree, tabId) {
    for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
        const tab = tabs.find((t) => t.id === tabId);
        if (tab) {
            return { tab, worktreeId };
        }
    }
    return null;
}
export function findGroupForTab(groupsByWorktree, worktreeId, groupId) {
    const groups = groupsByWorktree[worktreeId] ?? [];
    return groups.find((g) => g.id === groupId) ?? null;
}
export function findGroupAndWorktree(groupsByWorktree, groupId) {
    for (const [worktreeId, groups] of Object.entries(groupsByWorktree)) {
        const group = groups.find((candidate) => candidate.id === groupId);
        if (group) {
            return { group, worktreeId };
        }
    }
    return null;
}
export function findTabByEntityInGroup(tabsByWorktree, worktreeId, groupId, entityId, contentType) {
    const tabs = tabsByWorktree[worktreeId] ?? [];
    return (tabs.find((tab) => tab.groupId === groupId &&
        tab.entityId === entityId &&
        (contentType ? tab.contentType === contentType : true)) ?? null);
}
export function ensureGroup(groupsByWorktree, activeGroupIdByWorktree, worktreeId, preferredGroupId) {
    const existing = groupsByWorktree[worktreeId]?.find((group) => group.id === preferredGroupId) ??
        groupsByWorktree[worktreeId]?.[0];
    if (existing) {
        return { group: existing, groupsByWorktree, activeGroupIdByWorktree };
    }
    const groupId = globalThis.crypto.randomUUID();
    const group = { id: groupId, worktreeId, activeTabId: null, tabOrder: [] };
    return {
        group,
        groupsByWorktree: { ...groupsByWorktree, [worktreeId]: [group] },
        activeGroupIdByWorktree: { ...activeGroupIdByWorktree, [worktreeId]: groupId }
    };
}
/** Pick the nearest neighbor in visual order (right first, then left). */
export function pickNeighbor(tabOrder, closingTabId) {
    const idx = tabOrder.indexOf(closingTabId);
    if (idx === -1) {
        return null;
    }
    if (idx + 1 < tabOrder.length) {
        return tabOrder[idx + 1];
    }
    if (idx - 1 >= 0) {
        return tabOrder[idx - 1];
    }
    return null;
}
export function updateGroup(groups, updated) {
    return groups.map((g) => (g.id === updated.id ? updated : g));
}
export function isTransientEditorContentType(contentType) {
    return contentType === 'diff' || contentType === 'conflict-review';
}
export function getPersistedEditFileIdsByWorktree(session) {
    return Object.fromEntries(Object.entries(session.openFilesByWorktree ?? {}).map(([worktreeId, files]) => [
        worktreeId,
        new Set(files.map((file) => file.filePath))
    ]));
}
export function selectHydratedActiveGroupId(groups, persistedActiveGroupId) {
    const preferredGroups = groups.filter((group) => group.tabOrder.length > 0);
    const candidates = preferredGroups.length > 0 ? preferredGroups : groups;
    if (persistedActiveGroupId && candidates.some((group) => group.id === persistedActiveGroupId)) {
        return persistedActiveGroupId;
    }
    return candidates[0]?.id;
}
export function dedupeTabOrder(tabIds) {
    const seen = new Set();
    const deduped = [];
    for (const tabId of tabIds) {
        if (seen.has(tabId)) {
            continue;
        }
        seen.add(tabId);
        deduped.push(tabId);
    }
    return deduped;
}
/**
 * Apply a partial update to a single tab, returning the new `unifiedTabsByWorktree`
 * map. Returns `null` if the tab is not found (callers should return `{}` to the
 * zustand setter in that case).
 */
export function patchTab(tabsByWorktree, tabId, patch) {
    const found = findTabAndWorktree(tabsByWorktree, tabId);
    if (!found) {
        return null;
    }
    const { worktreeId } = found;
    const tabs = tabsByWorktree[worktreeId] ?? [];
    return {
        unifiedTabsByWorktree: {
            ...tabsByWorktree,
            [worktreeId]: tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t))
        }
    };
}
