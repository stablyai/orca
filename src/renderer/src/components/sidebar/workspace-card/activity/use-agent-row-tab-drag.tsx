import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { useAppStore } from '@/store/index'
import { useAppStateViewActive } from '@/store/retained-views/app-state-view'
import { reorderTabInGroup } from '@/runtime/workspace-layout/commands/tab-group-layout-owner-commands'
import { displayedTabOrder } from '@/components/bots/bot-home-tab-order'
import {
  createSidebarDragPreview,
  isSidebarPointerDragBlocked,
  setSidebarPointerDragDocumentStyles,
  updateSidebarDragPreviewPosition
} from '../../worktree-list/drag/worktree-sidebar-pointer-drag-dom'
import { swallowNextClickOnDragHandle } from '../../worktree-list/drag/header-drag-click-swallow'
import { WorktreeSidebarDropIndicator } from '../../worktree-list/drag/WorktreeSidebarDropIndicator'
import { visibleAgentTabs, type WorktreeTabLayout } from './worktree-agent-visible-tab-order'
import {
  agentRowDropTabOrder,
  type AgentRowDropSide,
  type AgentRowTabDrop
} from './worktree-agent-row-tab-drop'

const AGENT_ROOT_KEY_ATTR = 'data-agent-root-key'
const DRAG_START_DISTANCE_PX = 4

type PendingDrag = {
  key: string
  row: HTMLElement
  pointerId: number
  startX: number
  startY: number
  preview: { preview: HTMLElement; offsetX: number; offsetY: number } | null
  drop: AgentRowTabDrop | null
}

function tabLayoutOf(worktreeId: string): WorktreeTabLayout {
  const state = useAppStore.getState()
  return {
    tabs: state.unifiedTabsByWorktree[worktreeId] ?? [],
    groups: state.groupsByWorktree[worktreeId] ?? [],
    layout: state.layoutByWorktree[worktreeId],
    legacyOrder: state.tabBarOrderByWorktree[worktreeId] ?? []
  }
}

function tabRefOf(key: string): string | undefined {
  return useAppStore.getState().agentStatusByPaneKey.projection.row(key)?.tab.id
}

function dropFor(
  worktreeId: string,
  draggedKey: string,
  targetKey: string,
  side: AgentRowDropSide
): AgentRowTabDrop | null {
  const tabLayout = tabLayoutOf(worktreeId)
  return agentRowDropTabOrder({
    draggedTabRef: tabRefOf(draggedKey),
    targetTabRef: tabRefOf(targetKey),
    side,
    tabLayout,
    displayedOrderOf: (group) =>
      displayedTabOrder(
        group.tabOrder,
        tabLayout.tabs.filter((tab) => tab.groupId === group.id),
        worktreeId
      )
  })
}

function rootRows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(`[${AGENT_ROOT_KEY_ATTR}]`)]
}

/**
 * Pointer drag for a workspace card's root agent rows. A drop reorders the rows' tabs in the tab strip, which
 * the rows then follow, so the strip stays the one source of order. Rows without a visible tab cannot drag.
 */
export function useAgentRowTabDrag(
  worktreeId: string,
  containerRef: React.RefObject<HTMLDivElement | null>
): {
  handlers: {
    onPointerDownCapture: (event: React.PointerEvent<HTMLDivElement>) => void
    onDragStartCapture: (event: React.DragEvent<HTMLDivElement>) => void
  }
  indicatorY: number | null
} {
  const live = useAppStateViewActive()
  const pendingRef = useRef<PendingDrag | null>(null)
  const [pressed, setPressed] = useState(false)
  const [indicatorY, setIndicatorY] = useState<number | null>(null)

  const finish = useCallback(
    (commit: boolean) => {
      const pending = pendingRef.current
      pendingRef.current = null
      setPressed(false)
      setIndicatorY(null)
      if (!pending?.preview) {
        return
      }
      pending.preview.preview.remove()
      setSidebarPointerDragDocumentStyles(false)
      swallowNextClickOnDragHandle(pending.row)
      if (commit && pending.drop) {
        reorderTabInGroup(worktreeId, { kind: 'reorder', ...pending.drop })
      }
    },
    [worktreeId]
  )

  useEffect(() => () => finish(false), [finish])

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const pending = pendingRef.current
      const container = containerRef.current
      if (!pending || !container || event.pointerId !== pending.pointerId) {
        return
      }
      if (!pending.preview) {
        const distance = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY)
        if (distance < DRAG_START_DISTANCE_PX) {
          return
        }
        pending.preview = createSidebarDragPreview({
          sourceRow: pending.row,
          pointerX: event.clientX,
          pointerY: event.clientY,
          draggedCount: 1
        })
        setSidebarPointerDragDocumentStyles(true)
      }
      updateSidebarDragPreviewPosition({
        preview: pending.preview.preview,
        pointerX: event.clientX,
        pointerY: event.clientY,
        offsetX: pending.preview.offsetX,
        offsetY: pending.preview.offsetY
      })
      const rows = rootRows(container)
      const target =
        rows.find((row) => event.clientY < row.getBoundingClientRect().bottom) ?? rows.at(-1)
      const targetKey = target?.getAttribute(AGENT_ROOT_KEY_ATTR)
      if (!target || !targetKey) {
        pending.drop = null
        setIndicatorY(null)
        return
      }
      const rect = target.getBoundingClientRect()
      const side: AgentRowDropSide = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
      pending.drop = dropFor(worktreeId, pending.key, targetKey, side)
      const containerTop = container.getBoundingClientRect().top
      setIndicatorY(
        pending.drop ? (side === 'before' ? rect.top : rect.bottom) - containerTop : null
      )
    },
    [containerRef, worktreeId]
  )

  useEffect(() => {
    if (!pressed) {
      return undefined
    }
    const onUp = (event: PointerEvent): void => {
      if (event.pointerId === pendingRef.current?.pointerId) {
        finish(true)
      }
    }
    const onCancel = (): void => finish(false)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        finish(false)
      }
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onCancel)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onCancel)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [finish, onPointerMove, pressed])

  const onPointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!live || event.button !== 0 || pendingRef.current) {
        return
      }
      const row =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(`[${AGENT_ROOT_KEY_ATTR}]`)
          : null
      const key = row?.getAttribute(AGENT_ROOT_KEY_ATTR)
      if (!row || !key || isSidebarPointerDragBlocked(event.target, row)) {
        return
      }
      // Hydrating or retained rows have no tab to move, so they keep their place.
      const draggedTabRef = tabRefOf(key)
      if (
        draggedTabRef === undefined ||
        !visibleAgentTabs(tabLayoutOf(worktreeId)).get(draggedTabRef)?.tab
      ) {
        return
      }
      pendingRef.current = {
        key,
        row,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        preview: null,
        drop: null
      }
      setPressed(true)
    },
    [live, worktreeId]
  )

  // The workspace card drags natively; a pressed agent row must not start that drag.
  const onDragStartCapture = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (pendingRef.current) {
      event.preventDefault()
      event.stopPropagation()
    }
  }, [])

  const handlers = useMemo(
    () => ({ onPointerDownCapture, onDragStartCapture }),
    [onPointerDownCapture, onDragStartCapture]
  )
  return { handlers, indicatorY }
}

export function AgentRowDropIndicator({ y }: { y: number | null }): React.ReactElement | null {
  return y === null ? null : <WorktreeSidebarDropIndicator y={y} className="left-0 right-0" />
}
