import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/selectors'
import { useLineageMembers } from './use-lineage-members'
import { hasMembersBeyondTower } from './lineage-tower-members'
import type { LineageMember } from '../../../../../shared/lineage-discovery-types'

export type LineageTowerRouting = {
  towerKey: string | null
  /** True only once the host answered and resolved members beyond the tower itself. */
  showLineage: boolean
  members: LineageMember[]
  /** The host answered the members request; gates adding to the tower. */
  supported: boolean
  refresh: () => Promise<void>
}

/** invariant: Source Control, Checks and the tab rule route on the same resolved members from main. */
export function useLineageTowerRouting(enabled = true): LineageTowerRouting {
  const towerKey = useAppStore((s) =>
    enabled ? (s.activeWorkspaceKey ?? s.activeWorktreeId) : null
  )
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorktreePath = useActiveWorktree()?.path ?? null
  const { members, supported, refresh } = useLineageMembers(towerKey)
  const showLineage =
    supported && hasMembersBeyondTower(members, { id: activeWorktreeId, path: activeWorktreePath })
  return { towerKey, showLineage, members, supported, refresh }
}
