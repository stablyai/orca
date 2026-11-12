import { useAppStore } from '../../../index'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  getIndexedAllWorktrees as getCachedAllWorktrees,
  getIndexedWorktreeMap as getCachedWorktreeMap
} from './worktree-catalog-index'
import { selectWorktreesByRepo } from '../../../workspaces/catalog/workspace-record-fields'

const EMPTY_WORKTREES: Worktree[] = []

export const useWorktreesForRepo = (repoId: string | null) =>
  useAppStore((s) =>
    repoId ? (selectWorktreesByRepo(s)[repoId] ?? EMPTY_WORKTREES) : EMPTY_WORKTREES
  )

export const useAllWorktrees = () =>
  useAppStore((s) => getCachedAllWorktrees(selectWorktreesByRepo(s)))

export const useWorktreeMap = () =>
  useAppStore((s) => getCachedWorktreeMap(selectWorktreesByRepo(s)))
