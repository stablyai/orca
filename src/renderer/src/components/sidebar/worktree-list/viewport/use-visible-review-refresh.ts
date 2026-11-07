import { useEffect } from 'react'
import type React from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import { useAppStore } from '@/store'
import { useWorktreeChangeSummaryStore } from '@/store/worktree-change-summary'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { RenderRow } from '../listing/render-row'
import type { WorktreeItemRow } from '../listing/renderable-rows'
import { getMountedWorktreeOptions } from '../rows/option-dom'

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

type VisibleCardArgs = {
  enabled: boolean
  renderRows: RenderRow[]
  virtualItems: readonly VirtualItem[]
  viewportTop: number
  viewportHeight: number
  isOnScreen?: (id: string) => boolean
}

/** On-screen git workspace rows; bare, archived, and folder rows have no checkout to inspect. */
export function visibleGitWorktreeCards(args: VisibleCardArgs): Worktree[] {
  if (!args.enabled) {
    return []
  }
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
    .filter((worktree) => args.isOnScreen?.(worktree.id) ?? true)
}

export function visibleReviewCardIds(args: VisibleCardArgs): string[] {
  return visibleGitWorktreeCards(args)
    .filter((worktree) => Boolean(worktree.branch))
    .map((worktree) => worktree.id)
}

type VisibleCardReportingArgs = {
  renderRows: RenderRow[]
  virtualItems: readonly VirtualItem[]
  scrollRef: React.RefObject<HTMLDivElement | null>
}

function useVisibleCardPublisher<T>(
  args: VisibleCardReportingArgs & {
    enabled: boolean
    /** Keep stable: a new identity re-runs the visibility scan. */
    select: (cardArgs: VisibleCardArgs) => T[]
    publish: (items: T[]) => void
  }
): void {
  const { enabled, renderRows, virtualItems, scrollRef, select, publish } = args
  useEffect(() => {
    const update = (): void => {
      const scroll = scrollRef.current
      const viewport = scroll?.getBoundingClientRect()
      publish(
        scroll && document.visibilityState === 'visible'
          ? select({
              enabled,
              renderRows,
              virtualItems,
              viewportTop: scroll.scrollTop,
              viewportHeight: scroll.clientHeight,
              isOnScreen: (id) =>
                getMountedWorktreeOptions(id, scroll).some((option) => {
                  const surface = option.querySelector('[data-worktree-card-surface]')
                  const bounds = (surface?.firstElementChild ?? option).getBoundingClientRect()
                  return (
                    viewport !== undefined &&
                    bounds.height > 0 &&
                    bounds.top < viewport.bottom &&
                    bounds.bottom > viewport.top
                  )
                })
            })
          : []
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

export function useVisiblePrRefreshReporting(
  args: VisibleCardReportingArgs & {
    currentWorktreeId: string | null
    worktreeMap: Map<string, Worktree>
    groupBy: WorktreeGroupBy
    newCardStyle: boolean
  }
): void {
  const publish = useAppStore((s) => s.setVisibleReviewCardWorktreeIds)
  const cardProps = useAppStore((s) => s.worktreeCardProperties)
  const enabled =
    args.groupBy === 'pr-status' ||
    (args.newCardStyle
      ? cardProps.includes('status')
      : cardProps.includes('pr') || cardProps.includes('ci'))
  useVisibleCardPublisher({ ...args, enabled, select: visibleReviewCardIds, publish })
}

export function useVisibleChangeCardReporting(args: VisibleCardReportingArgs): void {
  const publish = useWorktreeChangeSummaryStore((s) => s.setVisibleWorktrees)
  const enabled = useAppStore((s) => s.settings?.showWorktreeUncommittedChanges !== false)
  useVisibleCardPublisher({ ...args, enabled, select: visibleGitWorktreeCards, publish })
}
