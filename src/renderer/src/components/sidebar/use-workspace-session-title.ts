import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { resolveIndexedWorktreeOwner } from '@/lib/worktree-runtime-owner-index'
import type { Tab } from '../../../../shared/tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorkspaceSessionTitle } from './workspace-session-title'

const EMPTY_TABS: readonly Tab[] = []

export function useWorkspaceSessionTitle(worktree: Worktree): string | undefined {
  const tabs = useAppStore((state) => state.unifiedTabsByWorktree?.[worktree.id] ?? EMPTY_TABS)
  const generatedTitlesEnabled = useAppStore(
    (state) => state.settings?.tabAutoGenerateTitle === true
  )
  const ambiguous = useAppStore(
    (state) => resolveIndexedWorktreeOwner(state.worktreesByRepo, worktree.id).kind === 'ambiguous'
  )
  return useMemo(
    () => getWorkspaceSessionTitle(worktree, tabs, generatedTitlesEnabled, ambiguous),
    [worktree, tabs, generatedTitlesEnabled, ambiguous]
  )
}
