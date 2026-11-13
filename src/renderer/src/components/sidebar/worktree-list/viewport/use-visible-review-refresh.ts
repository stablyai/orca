import { useEffect } from 'react'
import type React from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { RenderRow } from '../listing/render-row'
import type { WorktreeItemRow } from '../listing/renderable-rows'
import { getMountedWorktreeOptionsById } from '../rows/option-dom'

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

export function visibleReviewCardIds(args: {
  renderRows: RenderRow[]
  virtualItems: readonly VirtualItem[]
  viewportTop: number
  viewportHeight: number
}): string[] {
  const bottom = args.viewportTop + args.viewportHeight
  return args.virtualItems
    .filter((item) => item.start < bottom && item.end > args.viewportTop)
    .map((item) => args.renderRows[item.index])
    .flatMap((row): WorktreeItemRow[] =>
      row?.type === 'lineage-group' ? row.rows : row?.type === 'item' ? [row] : []
    )
    .filter(
      (row) =>
        (row.repo?.kind ?? 'git') === 'git' &&
        !row.worktree.isBare &&
        !row.worktree.isArchived &&
        Boolean(row.worktree.branch)
    )
    .map((row) => row.worktree.id)
}

export function useVisiblePrRefreshReporting(args: {
  currentWorktreeId: string | null
  worktreeMap: Map<string, Worktree>
  groupBy: WorktreeGroupBy
  newCardStyle: boolean
  renderRows: RenderRow[]
  virtualItems: readonly VirtualItem[]
  scrollRef: React.RefObject<HTMLDivElement | null>
}): void {
  const publish = useAppStore((s) => s.setVisibleReviewCardWorktreeIds)
  const cardProps = useAppStore((s) => s.worktreeCardProperties)
  const enabled =
    args.groupBy === 'pr-status' ||
    (args.newCardStyle
      ? cardProps.includes('status')
      : cardProps.includes('pr') || cardProps.includes('ci'))

  useEffect(() => {
    const update = (): void => {
      const scroll = args.scrollRef.current
      if (!enabled || !scroll || document.visibilityState !== 'visible') {
        publish([])
        return
      }
      const candidates = visibleReviewCardIds({
        renderRows: args.renderRows,
        virtualItems: args.virtualItems,
        viewportTop: scroll.scrollTop,
        viewportHeight: scroll.clientHeight
      })
      if (candidates.length === 0) {
        publish([])
        return
      }
      const viewport = scroll.getBoundingClientRect()
      const mountedOptions = getMountedWorktreeOptionsById(candidates, scroll)
      publish(
        candidates.filter((id) =>
          mountedOptions.get(id)?.some((option) => {
            const surface = option.querySelector('[data-worktree-card-surface]')
            const bounds = (surface?.firstElementChild ?? option).getBoundingClientRect()
            return bounds.height > 0 && bounds.top < viewport.bottom && bounds.bottom > viewport.top
          })
        )
      )
    }
    update()
    const stopVisibility = installWorktreeVisibleRefreshVisibilityListener(update)
    const scroll = args.scrollRef.current
    const stopScroll = scroll ? installVisibleReviewCardScrollListener(scroll, update) : () => {}
    return () => {
      stopVisibility()
      stopScroll()
    }
  }, [enabled, args.renderRows, args.virtualItems, args.scrollRef, publish])

  useEffect(() => () => publish([]), [publish])
}
