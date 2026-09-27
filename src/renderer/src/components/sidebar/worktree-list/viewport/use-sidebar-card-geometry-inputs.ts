import { selectWorktreeCardDisplayMode } from '../../worktree-card-layout'
import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { selectWorktreeAgentRowCandidateIds } from '../../worktree-agent-row-selectors'
import { reuseWorktreeMembership } from '../../worktree-agent-row-membership'
import {
  resolveSidebarCardGeometry,
  type SidebarCardGeometryResolver
} from '../listing/sidebar-card-geometry'

let previousConflicts: AppState['gitConflictOperationByWorktree'] | undefined
let previousRemoteConflicts: AppState['remoteBranchConflictByWorktreeId'] | undefined
let blockedIds: ReadonlySet<string> = new Set()
export function selectSidebarGeometryBlockedIds(
  state: Pick<AppState, 'gitConflictOperationByWorktree' | 'remoteBranchConflictByWorktreeId'>
): ReadonlySet<string> {
  if (
    previousConflicts === state.gitConflictOperationByWorktree &&
    previousRemoteConflicts === state.remoteBranchConflictByWorktreeId
  ) {
    return blockedIds
  }
  previousConflicts = state.gitConflictOperationByWorktree
  previousRemoteConflicts = state.remoteBranchConflictByWorktreeId
  const ids = new Set(Object.keys(state.remoteBranchConflictByWorktreeId))
  for (const [id, operation] of Object.entries(state.gitConflictOperationByWorktree)) {
    if (operation && operation !== 'unknown' && operation !== 'rebase') {
      ids.add(id)
    }
  }
  blockedIds = reuseWorktreeMembership(blockedIds, ids)
  return blockedIds
}

const EMPTY_CANDIDATES: ReadonlySet<string> = new Set()
const selectNoCandidates = () => EMPTY_CANDIDATES

export function useSidebarCardGeometryInputs(args: {
  newCardStyle: boolean
  compactPreference: boolean
  hasProjectGroups: boolean
  hideRepoBadge: boolean
  hasCardCandidates: boolean
}): SidebarCardGeometryResolver {
  const cardProps = useAppStore((state) => state.worktreeCardProperties)
  const display = selectWorktreeCardDisplayMode(
    args.newCardStyle,
    args.compactPreference,
    cardProps
  )
  const enabled =
    args.hasCardCandidates &&
    display.showInlineAgentList &&
    !display.compactCards &&
    (args.newCardStyle || !args.hideRepoBadge)
  const agentCandidateIds = useAppStore(
    enabled ? selectWorktreeAgentRowCandidateIds : selectNoCandidates
  )
  const blockedIds = useAppStore(enabled ? selectSidebarGeometryBlockedIds : selectNoCandidates)
  const { newCardStyle, compactPreference, hasProjectGroups, hideRepoBadge } = args
  return useMemo(() => {
    const inputs = {
      newCardStyle,
      compactPreference,
      hasProjectGroups,
      hideRepoBadge,
      cardProps,
      agentCandidateIds,
      blockedIds
    }
    return (row, expanded) => resolveSidebarCardGeometry(row, expanded, inputs)
  }, [
    newCardStyle,
    compactPreference,
    hasProjectGroups,
    hideRepoBadge,
    cardProps,
    agentCandidateIds,
    blockedIds
  ])
}
