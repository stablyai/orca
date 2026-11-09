import React from 'react'
import { useAppStore } from '@/store'
import type { PendingSidebarWorktreeReveal } from '@/store/slices/ui/ui-slice-contract-core'
import { isActiveSidebarWorkspace } from '../../../../../shared/sidebar-list/active-workspace'
import type { SidebarRailRow } from './sidebar-rail-rows'

type SidebarRailTileRow = Extract<SidebarRailRow, { kind: 'tile' }>

function findRevealTile(
  rows: readonly SidebarRailRow[],
  reveal: PendingSidebarWorktreeReveal
): SidebarRailTileRow | undefined {
  return rows.find(
    (row): row is SidebarRailTileRow =>
      row.kind === 'tile' &&
      (reveal.rowKey
        ? row.rowKey === reveal.rowKey
        : isActiveSidebarWorkspace(row.worktree, {
            worktreeId: reveal.worktreeId,
            hostId: reveal.executionHostId ?? null
          }))
  )
}

export function useRailPendingReveal(args: {
  rows: readonly SidebarRailRow[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  activeRowKey: string | undefined
  forcedRevealWorktreeId: string | null
  onForceReveal: (worktreeId: string | null) => void
  toggleGroup: (groupKey: string) => void
}): string | undefined {
  const { rows, scrollRef, activeRowKey, forcedRevealWorktreeId, onForceReveal, toggleGroup } = args
  const pendingReveal = useAppStore((s) => s.pendingRevealWorktree)
  const clearPendingReveal = useAppStore((s) => s.clearPendingRevealWorktreeId)
  const storedCollapsedGroups = useAppStore((s) => s.collapsedGroups)
  const [scrollTarget, setScrollTarget] = React.useState<{ key: string; activeKey?: string }>()

  React.useEffect(() => {
    if (!pendingReveal) {
      return
    }
    const forced = forcedRevealWorktreeId === pendingReveal.worktreeId
    const target = findRevealTile(rows, pendingReveal)
    if (!target) {
      if (!forced) {
        onForceReveal(pendingReveal.worktreeId)
        return
      }
      clearPendingReveal(pendingReveal)
      onForceReveal(null)
      return
    }
    if (forced) {
      for (const row of rows) {
        if (row.kind === 'header' && !row.collapsed && storedCollapsedGroups.has(row.collapseKey)) {
          toggleGroup(row.collapseKey)
        }
      }
    }
    setScrollTarget({ key: target.key, activeKey: activeRowKey })
    const frame = window.requestAnimationFrame(() => {
      clearPendingReveal(pendingReveal)
      if (forced) {
        onForceReveal(null)
      }
      scrollRef.current
        ?.querySelector(`[data-rail-row-key="${CSS.escape(target.key)}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: pendingReveal.behavior })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [
    activeRowKey,
    clearPendingReveal,
    forcedRevealWorktreeId,
    onForceReveal,
    pendingReveal,
    rows,
    scrollRef,
    storedCollapsedGroups,
    toggleGroup
  ])

  return scrollTarget && scrollTarget.activeKey === activeRowKey ? scrollTarget.key : activeRowKey
}
