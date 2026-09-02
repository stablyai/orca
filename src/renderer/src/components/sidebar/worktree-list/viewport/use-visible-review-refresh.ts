import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import { useAppStore } from '@/store'
import { rightSidebarShowsPullRequestData } from '@/lib/right-sidebar-visibility'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeGroupBy } from '../grouping/row-types'
import type { RenderRow } from '../listing/render-row'
import type { WorktreeItemRow } from '../listing/renderable-rows'

export function installWorktreeVisibleRefreshVisibilityListener(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

const DOCUMENT_HIDDEN_KEY = '__document_hidden__'
const NOTHING_TO_TRACK_KEY = '__hidden__'

// Reports which sidebar rows are on screen so the GitHub PR/CI coordinator can refresh
// exactly those, and no more.
export function useVisiblePrRefreshReporting(args: {
  currentWorktreeId: string | null
  worktreeMap: Map<string, Worktree>
  groupBy: WorktreeGroupBy
  newCardStyle: boolean
  renderRows: RenderRow[]
  virtualItems: readonly VirtualItem[]
  scrollRef: React.RefObject<HTMLDivElement | null>
}): void {
  const {
    currentWorktreeId,
    worktreeMap,
    groupBy,
    newCardStyle,
    renderRows,
    virtualItems,
    scrollRef
  } = args
  const [documentVisibilityRevision, setDocumentVisibilityRevision] = useState(0)
  const lastVisibleRefreshKeyRef = useRef('')
  const reportVisibleGitHubPRRefreshCandidates = useAppStore(
    (s) => s.reportVisibleGitHubPRRefreshCandidates
  )
  const cardProps = useAppStore((s) => s.worktreeCardProperties)
  const rightSidebarShowsPR = useAppStore((s) => rightSidebarShowsPullRequestData(s))
  const sshConnectedGeneration = useAppStore((s) => s.sshConnectedGeneration)
  const prVisibleRefreshGeneration = useAppStore((s) => s.prVisibleRefreshGeneration)

  useEffect(
    () =>
      installWorktreeVisibleRefreshVisibilityListener(() => {
        if (document.visibilityState !== 'visible') {
          // Why: row identity may be unchanged after a hidden window; reset the key so PR/CI rows refresh.
          lastVisibleRefreshKeyRef.current = DOCUMENT_HIDDEN_KEY
          return
        }
        setDocumentVisibilityRevision((revision) => revision + 1)
      }),
    []
  )

  useEffect(() => {
    if (document.visibilityState !== 'visible') {
      lastVisibleRefreshKeyRef.current = DOCUMENT_HIDDEN_KEY
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
      if (lastVisibleRefreshKeyRef.current !== NOTHING_TO_TRACK_KEY) {
        lastVisibleRefreshKeyRef.current = NOTHING_TO_TRACK_KEY
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
    renderRows,
    reportVisibleGitHubPRRefreshCandidates,
    prVisibleRefreshGeneration,
    rightSidebarShowsPR,
    scrollRef,
    sshConnectedGeneration,
    newCardStyle,
    virtualItems,
    worktreeMap
  ])
}
