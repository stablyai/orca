import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useAllWorktrees, useRepos } from '@/store/selectors'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  useAiVaultSessionOwnerWorkspaces,
  useAiVaultSessionWorktreeMap
} from '../right-sidebar/ai-vault-session-worktree'
import {
  resolveSessionsBoardCardAvailability,
  type SessionsBoardCardAvailability
} from './sessions-board-card-availability'

/**
 * Per-session action availability for every card on the board, in one pass.
 *
 * `sessions` must be the raw scan array, not anything derived from the search query: the
 * worktree map inside is keyed on that array's identity, so a per-keystroke array would rebuild
 * cwd matching for every session on every character typed.
 *
 * Keyed by `session.id`, which is what the worktree map is keyed by. The board's React keys use
 * `executionHostId:filePath` instead — the two are not interchangeable, and confusing them
 * silently disables every card rather than failing.
 */
export function useSessionsBoardCardAvailability(
  sessions: readonly AiVaultSession[]
): ReadonlyMap<string, SessionsBoardCardAvailability> {
  const repos = useRepos()
  const allWorktrees = useAllWorktrees()
  // Why useShallow: an inline object would be a new identity every render, and it feeds both
  // the owner-workspace list and the worktree map.
  const targetState = useAppStore(
    useShallow((state) => ({
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo
    }))
  )
  const ownerWorkspaces = useAiVaultSessionOwnerWorkspaces(allWorktrees, targetState)
  const worktreeInfoById = useAiVaultSessionWorktreeMap({
    sessions,
    repos,
    worktrees: ownerWorkspaces
  })

  return useMemo(() => {
    const byId = new Map<string, SessionsBoardCardAvailability>()
    for (const session of sessions) {
      byId.set(
        session.id,
        resolveSessionsBoardCardAvailability({
          session,
          worktreeInfo: worktreeInfoById.get(session.id) ?? null,
          repos,
          ownerWorkspaces,
          targetState
        })
      )
    }
    return byId
  }, [ownerWorkspaces, repos, sessions, targetState, worktreeInfoById])
}
