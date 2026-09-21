import { useLayoutEffect, useMemo, useRef } from 'react'
import type React from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import type { RenderRow } from '../listing/render-row'
import { getRenderRowKey } from '../listing/render-row'

export const WORKTREE_ROW_REMOVAL_ANIMATION_MS = 180

export type VirtualRowLayoutSnapshot = {
  rowIdentityKeys: ReadonlySet<string>
  scrollTop: number
  startsByKey: ReadonlyMap<string, number>
}

export type VirtualRowRemovalMotion = {
  deltaY: number
  key: string
}

export function getSidebarRowIdentityKeys(rows: readonly RenderRow[]): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const row of rows) {
    if (row.type === 'lineage-group') {
      row.rows.forEach((member) => keys.add(`wt:${member.rowKey}`))
    } else {
      keys.add(getRenderRowKey(row))
    }
  }
  return keys
}

export function buildVirtualRowRemovalMotions(args: {
  previous: VirtualRowLayoutSnapshot | null
  current: VirtualRowLayoutSnapshot
  rekeyedRowKeys: ReadonlyMap<string, string>
}): VirtualRowRemovalMotion[] {
  const { previous, current, rekeyedRowKeys } = args
  if (previous === null || previous.rowIdentityKeys === current.rowIdentityKeys) {
    return []
  }
  let removedRow = false
  for (const key of previous.rowIdentityKeys) {
    if (!current.rowIdentityKeys.has(key)) {
      removedRow = true
      break
    }
  }
  if (!removedRow) {
    return []
  }

  const previousKeyByCurrentKey = new Map<string, string>()
  rekeyedRowKeys.forEach((currentKey, previousKey) => {
    previousKeyByCurrentKey.set(currentKey, previousKey)
  })
  const motions: VirtualRowRemovalMotion[] = []
  current.startsByKey.forEach((currentStart, key) => {
    const previousKey = previous.startsByKey.has(key) ? key : previousKeyByCurrentKey.get(key)
    const previousStart = previousKey ? previous.startsByKey.get(previousKey) : undefined
    if (previousStart === undefined) {
      return
    }
    const deltaY = previousStart - previous.scrollTop - (currentStart - current.scrollTop)
    if (Math.abs(deltaY) > 0.5) {
      motions.push({ deltaY, key })
    }
  })
  return motions
}

export function useVirtualRowRemovalAnimation(args: {
  renderRows: readonly RenderRow[]
  rekeyedRowKeys: ReadonlyMap<string, string>
  scrollRef: React.RefObject<HTMLDivElement | null>
  virtualItems: readonly VirtualItem[]
}): void {
  const { renderRows, rekeyedRowKeys, scrollRef, virtualItems } = args
  const previousSnapshotRef = useRef<VirtualRowLayoutSnapshot | null>(null)
  const rowIdentityKeys = useMemo(() => getSidebarRowIdentityKeys(renderRows), [renderRows])

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement) {
      return
    }
    const current: VirtualRowLayoutSnapshot = {
      rowIdentityKeys,
      scrollTop: scrollElement.scrollTop,
      startsByKey: new Map(virtualItems.map((item) => [String(item.key), item.start]))
    }
    const motions = buildVirtualRowRemovalMotions({
      previous: previousSnapshotRef.current,
      current,
      rekeyedRowKeys
    })
    previousSnapshotRef.current = current
    if (motions.length === 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return
    }

    const elementsByKey = new Map(
      Array.from(
        scrollElement.querySelectorAll<HTMLElement>('[data-worktree-virtual-row-key]')
      ).map((element) => [element.dataset.worktreeVirtualRowKey ?? '', element])
    )
    for (const motion of motions) {
      const element = elementsByKey.get(motion.key)
      if (!element || element.hasAttribute('data-worktree-sticky-header-active')) {
        continue
      }
      const content = element.firstElementChild
      if (!(content instanceof HTMLElement)) {
        continue
      }
      content.animate([{ translate: `0 ${motion.deltaY}px` }, { translate: '0 0' }], {
        duration: WORKTREE_ROW_REMOVAL_ANIMATION_MS,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)'
      })
    }
  }, [rekeyedRowKeys, rowIdentityKeys, scrollRef, virtualItems])
}
