import { useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../../../shared/worktree/types'

/**
 * Owns which worktree the Source Control panel is showing. With no pin the panel follows the
 * app-active worktree on every switch (including same-repo switches, since the right sidebar
 * stays mounted); the user can pin another worktree of the same repo through the picker. The pin
 * survives app-active switches within the same repo (so a reviewed worktree stays in view while
 * the user works elsewhere), resets when the active repo changes, and falls back to the app-active
 * worktree when the pinned one disappears from the catalog.
 *
 * The known-worktree catalog spans both registered workspaces and detected git worktrees, so a pin
 * can target a worktree Orca has only detected (e.g. externally created siblings hidden from the
 * sidebar by the visibility policy).
 */
export function useSourceControlViewWorktreeSelection(): {
  subjectWorktreeId: string | null
  setViewWorktreeId: (worktreeId: string) => void
} {
  const appActiveWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const detectedWorktreesByRepo = useAppStore((s) => s.detectedWorktreesByRepo)
  const knownWorktreeById = useMemo(() => {
    const map = new Map<string, Worktree>()
    for (const list of Object.values(worktreesByRepo ?? {})) {
      for (const worktree of list) {
        map.set(worktree.id, worktree)
      }
    }
    for (const result of Object.values(detectedWorktreesByRepo ?? {})) {
      for (const worktree of result.worktrees) {
        if (!map.has(worktree.id)) {
          map.set(worktree.id, worktree)
        }
      }
    }
    return map
  }, [detectedWorktreesByRepo, worktreesByRepo])
  const appActiveRepoId = knownWorktreeById.get(appActiveWorktreeId ?? '')?.repoId ?? null
  // Why: null means "not pinned" — the subject falls back to the app-active worktree below, so a
  // same-repo app-active switch is followed without an explicit pick. Only a picker selection
  // assigns a real pin.
  const [viewWorktreeId, setViewWorktreeId] = useState<string | null>(null)
  // Why: reset during render instead of key-remounting on switch (which caused a Windows IPC storm).
  // Keyed to the repo so a same-repo app-active switch keeps the user's explicit pin.
  const [selectionRepoId, setSelectionRepoId] = useState(appActiveRepoId)
  if (selectionRepoId !== appActiveRepoId) {
    setSelectionRepoId(appActiveRepoId)
    setViewWorktreeId(null)
  }
  const subjectWorktreeId =
    viewWorktreeId && knownWorktreeById.has(viewWorktreeId) ? viewWorktreeId : appActiveWorktreeId
  return { subjectWorktreeId, setViewWorktreeId }
}
