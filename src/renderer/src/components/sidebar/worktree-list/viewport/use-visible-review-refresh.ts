import { useCallback, useEffect } from 'react'
import type React from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import { useAppStore } from '@/store'
import { useWorktreeChangeSummaryStore } from '@/store/worktree-change-summary'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { RenderRow } from '../listing/render-row'
import type { WorktreeItemRow } from '../listing/renderable-rows'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { getMountedWorktreeCopyOptions } from '../rows/option-dom'

export function installWorktreeVisibleRefreshVisibilityListener(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

export function installVisibleReviewCardScrollListener(
  scroll: Pick<HTMLElement, 'addEventListener' | 'removeEventListener'>,
  update: () => void
): () => void {
  let frame: number | null = null
  const onScroll = (): void => {
    if (frame !== null) {
      return
    }
    frame = requestAnimationFrame(() => {
      frame = null
      update()
    })
  }
  scroll.addEventListener('scroll', onScroll, { passive: true })
  return () => {
    scroll.removeEventListener('scroll', onScroll)
    if (frame !== null) {
      cancelAnimationFrame(frame)
    }
  }
}

type VisibleCardViewport = {
  renderRows: RenderRow[]
  virtualItems: readonly VirtualItem[]
  viewportTop: number
  viewportHeight: number
}

/** Git workspace rows in the viewport; bare, archived, and folder rows have no checkout to inspect. */
export function visibleGitWorktreeCards(args: VisibleCardViewport): Worktree[] {
  const bottom = args.viewportTop + args.viewportHeight
  return args.virtualItems
    .filter((item) => item.start < bottom && item.end > args.viewportTop)
    .map((item) => args.renderRows[item.index])
    .flatMap((row): WorktreeItemRow[] =>
      row?.type === 'lineage-group' ? row.rows : row?.type === 'item' ? [row] : []
    )
    .filter(
      (row) =>
        (row.repo?.kind ?? 'git') === 'git' && !row.worktree.isBare && !row.worktree.isArchived
    )
    .map((row) => row.worktree)
}

function visibleReviewCards(args: VisibleCardViewport): Worktree[] {
  return visibleGitWorktreeCards(args).filter((worktree) => Boolean(worktree.branch))
}

type VisibleCardReportingArgs = {
  renderRows: RenderRow[]
  virtualItems: readonly VirtualItem[]
  scrollRef: React.RefObject<HTMLDivElement | null>
}

function useVisibleCardPublisher(
  args: VisibleCardReportingArgs & {
    enabled: boolean
    select: (viewport: VisibleCardViewport) => Worktree[]
    /** Keep stable: a new identity re-runs the visibility scan. */
    publish: (cards: Worktree[]) => void
  }
): void {
  const { enabled, renderRows, virtualItems, scrollRef, select, publish } = args
  useEffect(() => {
    const update = (): void => {
      const scroll = scrollRef.current
      if (!enabled || !scroll || document.visibilityState !== 'visible') {
        publish([])
        return
      }
      const candidates = select({
        renderRows,
        virtualItems,
        viewportTop: scroll.scrollTop,
        viewportHeight: scroll.clientHeight
      })
      if (candidates.length === 0) {
        publish([])
        return
      }
      const viewport = scroll.getBoundingClientRect()
      const mountedOptions = getMountedWorktreeCopyOptions(candidates, scroll)
      publish(
        candidates.filter((worktree) =>
          mountedOptions.get(getWorktreeHostIdentity(worktree))?.some((option) => {
            const surface = option.querySelector('[data-worktree-card-surface]')
            const bounds = (surface?.firstElementChild ?? option).getBoundingClientRect()
            return bounds.height > 0 && bounds.top < viewport.bottom && bounds.bottom > viewport.top
          })
        )
      )
    }
    update()
    const stopVisibility = installWorktreeVisibleRefreshVisibilityListener(update)
    const scroll = scrollRef.current
    const stopScroll = scroll ? installVisibleReviewCardScrollListener(scroll, update) : () => {}
    return () => {
      stopVisibility()
      stopScroll()
    }
  }, [enabled, renderRows, virtualItems, scrollRef, select, publish])

  useEffect(() => () => publish([]), [publish])
}

type VisibleWorktreeCardReportingArgs = VisibleCardReportingArgs & {
  currentWorktreeId: string | null
  worktreeMap: Map<string, Worktree>
  groupBy: WorktreeGroupBy
  newCardStyle: boolean
}

function useVisiblePrRefreshReporting(args: VisibleWorktreeCardReportingArgs): void {
  const setVisibleIds = useAppStore((s) => s.setVisibleReviewCardWorktreeIds)
  const cardProps = useAppStore((s) => s.worktreeCardProperties)
  const enabled =
    args.groupBy === 'pr-status' ||
    (args.newCardStyle
      ? cardProps.includes('status')
      : cardProps.includes('pr') || cardProps.includes('ci'))
  const publish = useCallback(
    (cards: Worktree[]) => setVisibleIds(cards.map((worktree) => worktree.id)),
    [setVisibleIds]
  )
  useVisibleCardPublisher({ ...args, enabled, select: visibleReviewCards, publish })
}

function useVisibleChangeCardReporting(args: VisibleCardReportingArgs): void {
  const publish = useWorktreeChangeSummaryStore((s) => s.setVisibleWorktrees)
  const enabled = useAppStore((s) => s.settings?.showWorktreeUncommittedChanges !== false)
  useVisibleCardPublisher({ ...args, enabled, select: visibleGitWorktreeCards, publish })
}

/** Reports on-screen cards to the PR/CI refresher and the uncommitted-changes reader. */
export function useVisibleWorktreeCardReporting(args: VisibleWorktreeCardReportingArgs): void {
  useVisiblePrRefreshReporting(args)
  useVisibleChangeCardReporting(args)
}
