import { createContext, useContext } from 'react'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../../shared/worktree/types'

const NO_HIDDEN_ROWS: ReadonlySet<string> = new Set()

/** Host identities the sidebar lists although its filters hide them (the active workspace). */
export const SidebarFilterHiddenRowsContext = createContext<ReadonlySet<string>>(NO_HIDDEN_ROWS)

export function useIsRowHiddenBySidebarFilters(worktree: Pick<Worktree, 'id' | 'hostId'>): boolean {
  return useContext(SidebarFilterHiddenRowsContext).has(getWorktreeHostIdentity(worktree))
}
