import { useEffect, type MutableRefObject } from 'react'
import type { Worktree } from '../../../../shared/types'
import type { RenderRow } from './worktree-list-virtual-rows'
import type { WorktreeGroupBy } from './worktree-list-groups'
import type { WorktreeItemRow } from './worktree-list-render-row-model'

type Args = {
  lastVisibleRefreshKeyRef: MutableRefObject<string>
  currentWorktreeId: string | null
  worktreeMap: Map<string, Worktree>
  rightSidebarShowsPR: boolean
  groupBy: WorktreeGroupBy
  newCardStyle: boolean
  cardProps: readonly string[]
  scrollRef: MutableRefObject<HTMLDivElement | null>
  virtualItems: readonly { start: number; end: number; index: number }[]
  renderRows: readonly RenderRow[]
  sshConnectedGeneration: number
  prVisibleRefreshGeneration: number
  reportVisibleGitHubPRRefreshCandidates: (ids: string[], now: number) => void
  documentVisibilityRevision: number
}

export function useWorktreeVisibleReviewRefresh(args: Args): void {
  const {
    lastVisibleRefreshKeyRef,
    currentWorktreeId,
    worktreeMap,
    rightSidebarShowsPR,
    groupBy,
    newCardStyle,
    cardProps,
    scrollRef,
    virtualItems,
    renderRows,
    sshConnectedGeneration,
    prVisibleRefreshGeneration,
    reportVisibleGitHubPRRefreshCandidates,
    documentVisibilityRevision
  } = args
  useEffect(() => {
    if (document.visibilityState !== 'visible') {
      lastVisibleRefreshKeyRef.current = '__document_hidden__'
      return
    }
    const currentWorktree = currentWorktreeId ? (worktreeMap.get(currentWorktreeId) ?? null) : null
    // Why: this reporter feeds the GitHub coordinator; GitLab-only MR panels refresh via hosted-review paths.
    const sidebarWorktreeHasGitHubReview =
      currentWorktree !== null &&
      ((currentWorktree.linkedGitLabMR ?? null) === null ||
        (currentWorktree.linkedPR ?? null) !== null)
    const shouldTrackSidebarWorktree = rightSidebarShowsPR && sidebarWorktreeHasGitHubReview
    const shouldTrackVisibleRows =
      groupBy === 'pr-status' ||
      (newCardStyle
        ? cardProps.includes('status')
        : cardProps.includes('pr') || cardProps.includes('ci'))
    if (!shouldTrackVisibleRows && !shouldTrackSidebarWorktree) {
      if (lastVisibleRefreshKeyRef.current !== '__hidden__') {
        lastVisibleRefreshKeyRef.current = '__hidden__'
        reportVisibleGitHubPRRefreshCandidates([], Date.now())
      }
      return
    }
    const scrollEl = scrollRef.current
    if (!scrollEl) {
      return
    }
    const viewportTop = scrollEl.scrollTop
    const viewportBottom = viewportTop + scrollEl.clientHeight
    const visibleRows = virtualItems
      .filter((item) => item.start < viewportBottom && item.end > viewportTop)
      .map((item) => renderRows[item.index])
      .filter((row): row is WorktreeItemRow => row?.type === 'item')
      .filter((row) => row.repo?.kind === 'git' && !row.worktree.isBare && row.worktree.branch)
    const visibleWorktreeIds = new Set(visibleRows.map((row) => row.worktree.id))
    if (
      shouldTrackSidebarWorktree &&
      currentWorktree &&
      !currentWorktree.isBare &&
      currentWorktree.branch
    ) {
      visibleWorktreeIds.add(currentWorktree.id)
    }
    const visibleIdentity = visibleRows
      .map((row) => `${row.worktree.id}:${row.worktree.branch}:${row.worktree.linkedPR ?? ''}`)
      .join('|')
    const sidebarIdentity =
      shouldTrackSidebarWorktree && currentWorktree
        ? `${currentWorktree.id}:${currentWorktree.branch}:${currentWorktree.linkedPR ?? ''}`
        : ''
    const key = `${visibleIdentity}:${sidebarIdentity}:${sshConnectedGeneration}:${prVisibleRefreshGeneration}:${cardProps.join(',')}`
    if (!key || key === lastVisibleRefreshKeyRef.current) {
      return
    }
    lastVisibleRefreshKeyRef.current = key
    reportVisibleGitHubPRRefreshCandidates(Array.from(visibleWorktreeIds), Date.now())
  }, [
    cardProps,
    currentWorktreeId,
    documentVisibilityRevision,
    groupBy,
    lastVisibleRefreshKeyRef,
    renderRows,
    reportVisibleGitHubPRRefreshCandidates,
    prVisibleRefreshGeneration,
    rightSidebarShowsPR,
    sshConnectedGeneration,
    scrollRef,
    newCardStyle,
    virtualItems,
    worktreeMap
  ])
}
