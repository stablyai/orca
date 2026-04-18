import type { AppState } from '../types';
import type { Worktree, TerminalTab, TerminalLayoutSnapshot, Tab, TabGroup } from '../../../../shared/types';
import type { OpenFile } from './editor';
export declare const TEST_REPO: {
    id: string;
    path: string;
    displayName: string;
    badgeColor: string;
    addedAt: number;
};
export declare function createTestStore(): import("zustand").UseBoundStore<import("zustand").StoreApi<AppState>>;
export declare function seedStore(store: ReturnType<typeof createTestStore>, state: Partial<AppState>): void;
export declare function makeWorktree(overrides: Partial<Worktree> & {
    id: string;
    repoId: string;
}): Worktree;
export declare function makeTab(overrides: Partial<TerminalTab> & {
    id: string;
    worktreeId: string;
}): TerminalTab;
export declare function makeLayout(): TerminalLayoutSnapshot;
export declare function makeOpenFile(overrides: Partial<OpenFile> & {
    id: string;
    worktreeId: string;
}): OpenFile;
export declare function makeUnifiedTab(overrides: Partial<Tab> & {
    id: string;
    worktreeId: string;
    groupId: string;
}): Tab;
export declare function makeTabGroup(overrides: Partial<TabGroup> & {
    id: string;
    worktreeId: string;
}): TabGroup;
