import { useAppStore } from '@/store'
import {
  getWorktreeIdFromHostIdentity,
  type HostScopedWorktreeKey
} from '../../../../../../shared/worktree/host-qualified-identity'
import { useWorktreeAgentExpansionState } from '../activity/worktree-card-agents-expansion-state'

/** A 2.0 card is open when the user opened it, or when it holds the active workspace so selection never hides. */
export function useWorktreeCardOpen(
  worktreeId: string,
  descendants: readonly HostScopedWorktreeKey[] | undefined
): { open: boolean; toggle: () => void } {
  const { cardOpen, toggleCardOpen } = useWorktreeAgentExpansionState(worktreeId)
  const holdsActive = useAppStore((s) => {
    const activeId = s.activeWorktreeId
    return (
      activeId !== null &&
      descendants !== undefined &&
      descendants.some((identity) => getWorktreeIdFromHostIdentity(identity) === activeId)
    )
  })
  return { open: cardOpen || holdsActive, toggle: toggleCardOpen }
}
