import type { Tab, TabGroup, TabGroupLayoutNode, WorkspaceSessionState } from '../../../../shared/types';
type HydratedTabState = {
    unifiedTabsByWorktree: Record<string, Tab[]>;
    groupsByWorktree: Record<string, TabGroup[]>;
    activeGroupIdByWorktree: Record<string, string>;
    layoutByWorktree: Record<string, TabGroupLayoutNode>;
};
export declare function buildHydratedTabState(session: WorkspaceSessionState, validWorktreeIds: Set<string>): HydratedTabState;
export {};
