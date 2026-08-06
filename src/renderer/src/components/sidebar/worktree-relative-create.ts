import type { WorkspaceKey, WorkspaceLineage, Worktree } from '../../../../shared/types'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from '@/lib/worktree-default-display-name'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'

export type RelativeWorktreeCreateKind = 'fork' | 'child'

export function getRelativeWorktreeDefaultName(
  worktree: Worktree,
  kind: RelativeWorktreeCreateKind
): string {
  const sourceName = resolveWorktreeBranchLabel(worktree) || resolveWorktreeDisplayName(worktree)
  return `${sourceName}_${kind}`
}

export function getRelativeWorktreeParent(args: {
  kind: RelativeWorktreeCreateKind
  worktree: Worktree
  workspaceLineage?: WorkspaceLineage | null
  validParentWorktreeId?: string | null
}): WorkspaceKey | null {
  if (args.kind === 'child') {
    return worktreeWorkspaceKey(args.worktree.id)
  }
  const workspaceParent = args.workspaceLineage
    ? parseWorkspaceKey(args.workspaceLineage.parentWorkspaceKey)
    : null
  if (workspaceParent?.type === 'folder') {
    return args.workspaceLineage?.parentWorkspaceKey ?? null
  }
  return args.validParentWorktreeId ? worktreeWorkspaceKey(args.validParentWorktreeId) : null
}
