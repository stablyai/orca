import { dirname } from '@/lib/path'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import {
  getWorktreePathBasenameFromId,
  splitWorktreeIdForFilesystem
} from '../../../shared/worktree/id'
import type {
  ResumeRepoGroup,
  ResumeWorkspaceGroup
} from './native-chat-resume-on-restart-grouping'

type WorkspaceFallback = { name: string; parentPath: string }
export type WorkspaceFallbacks = ReadonlyMap<ResumeWorkspaceGroup, WorkspaceFallback>

export function deriveFallbacks(repoGroup: ResumeRepoGroup): WorkspaceFallbacks {
  const fallbackDisplays = new Map<ResumeWorkspaceGroup, WorkspaceFallback>()
  if (repoGroup.repoId === null) {
    const countByName = new Map<string, number>()
    for (const group of repoGroup.workspaces) {
      const name = getWorktreePathBasenameFromId(group.workspaceId) || group.workspaceId
      const path = splitWorktreeIdForFilesystem(group.workspaceId)?.worktreePath
      fallbackDisplays.set(group, { name, parentPath: path ? dirname(path) : '' })
      countByName.set(name, (countByName.get(name) ?? 0) + 1)
    }
    for (const display of fallbackDisplays.values()) {
      if (countByName.get(display.name) === 1) {
        display.parentPath = ''
      }
    }
  }
  return fallbackDisplays
}

export function resolveName(
  worktree: Parameters<typeof resolveWorktreeDisplayName>[0] | undefined,
  fallback: WorkspaceFallback | undefined,
  workspaceId: string
): string {
  return (
    (worktree && resolveWorktreeDisplayName(worktree)) ||
    fallback?.name ||
    getWorktreePathBasenameFromId(workspaceId) ||
    workspaceId
  )
}
