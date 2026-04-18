import { describe, expect, it } from 'vitest';
import { createTestStore, makeTabGroup, makeWorktree, seedStore } from './store-test-helpers';
describe('browser slice', () => {
    it('reopens the most recently closed browser tab in the same worktree', () => {
        const store = createTestStore();
        const worktreeId = 'repo1::/tmp/wt-1';
        seedStore(store, {
            activeRepoId: 'repo1',
            activeWorktreeId: worktreeId,
            activeTabType: 'browser',
            worktreesByRepo: {
                repo1: [
                    makeWorktree({
                        id: worktreeId,
                        repoId: 'repo1',
                        path: '/tmp/wt-1'
                    })
                ]
            },
            groupsByWorktree: {
                [worktreeId]: [
                    makeTabGroup({
                        id: 'group-1',
                        worktreeId,
                        activeTabId: null,
                        tabOrder: []
                    })
                ]
            },
            activeGroupIdByWorktree: {
                [worktreeId]: 'group-1'
            },
            browserTabsByWorktree: {},
            unifiedTabsByWorktree: {}
        });
        const created = store.getState().createBrowserTab(worktreeId, 'https://example.com/docs', {
            title: 'Docs'
        });
        store.getState().closeBrowserTab(created.id);
        expect(store.getState().browserTabsByWorktree[worktreeId]).toBeUndefined();
        expect(store.getState().recentlyClosedBrowserTabsByWorktree[worktreeId]).toHaveLength(1);
        const reopened = store.getState().reopenClosedBrowserTab(worktreeId);
        expect(reopened).not.toBeNull();
        expect(reopened?.id).not.toBe(created.id);
        expect(reopened?.url).toBe('https://example.com/docs');
        expect(reopened?.title).toBe('Docs');
        expect(store.getState().browserTabsByWorktree[worktreeId]).toHaveLength(1);
        expect(store.getState().recentlyClosedBrowserTabsByWorktree[worktreeId]).toHaveLength(0);
    });
    it('reopens a multi-page workspace without duplicating the active URL (page order ≠ active first)', () => {
        const store = createTestStore();
        const worktreeId = 'repo1::/tmp/wt-1';
        seedStore(store, {
            activeRepoId: 'repo1',
            activeWorktreeId: worktreeId,
            activeTabType: 'browser',
            worktreesByRepo: {
                repo1: [
                    makeWorktree({
                        id: worktreeId,
                        repoId: 'repo1',
                        path: '/tmp/wt-1'
                    })
                ]
            },
            groupsByWorktree: {
                [worktreeId]: [
                    makeTabGroup({
                        id: 'group-1',
                        worktreeId,
                        activeTabId: null,
                        tabOrder: []
                    })
                ]
            },
            activeGroupIdByWorktree: {
                [worktreeId]: 'group-1'
            },
            browserTabsByWorktree: {},
            unifiedTabsByWorktree: {}
        });
        const ws = store.getState().createBrowserTab(worktreeId, 'https://example.com/a', {
            title: 'A'
        });
        store
            .getState()
            .createBrowserPage(ws.id, 'https://example.com/b', { title: 'B', activate: true });
        const beforeClose = store.getState().browserPagesByWorkspace[ws.id] ?? [];
        expect(beforeClose).toHaveLength(2);
        expect(store.getState().browserTabsByWorktree[worktreeId]?.[0]?.url).toBe('https://example.com/b');
        store.getState().closeBrowserTab(ws.id);
        const reopened = store.getState().reopenClosedBrowserTab(worktreeId);
        expect(reopened).not.toBeNull();
        const pages = store.getState().browserPagesByWorkspace[reopened.id] ?? [];
        expect(pages).toHaveLength(2);
        const urls = new Set(pages.map((p) => p.url));
        expect(urls.has('https://example.com/a')).toBe(true);
        expect(urls.has('https://example.com/b')).toBe(true);
        expect(store.getState().browserTabsByWorktree[worktreeId]?.[0]?.url).toBe('https://example.com/b');
    });
});
