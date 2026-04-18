import type { TabGroup, TabGroupLayoutNode } from '../../../../shared/types';
/**
 * Derive the effective layout for a worktree: either its explicit layout
 * or a synthetic leaf wrapping its first/active group.
 */
export declare function getEffectiveLayoutForWorktree(worktreeId: string, layoutByWorktree: Record<string, TabGroupLayoutNode | undefined>, groupsByWorktree: Record<string, TabGroup[]>, activeGroupIdByWorktree: Record<string, string | undefined>): TabGroupLayoutNode | undefined;
/**
 * Returns true if any mounted worktree has a split-group layout.
 *
 * Why: the split-group container hosts ALL mounted worktrees' pane trees.
 * Gating it on only the *active* worktree's layout causes the entire tree
 * to unmount when switching to a newly-activated worktree that has no
 * groups yet — destroying PaneManagers, xterm buffers, and PTY connections.
 */
export declare function anyMountedWorktreeHasLayout(allWorktreeIds: string[], mountedWorktreeIds: ReadonlySet<string>, layoutByWorktree: Record<string, TabGroupLayoutNode | undefined>, groupsByWorktree: Record<string, TabGroup[]>, activeGroupIdByWorktree: Record<string, string | undefined>): boolean;
