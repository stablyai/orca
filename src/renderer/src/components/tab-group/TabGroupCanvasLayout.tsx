import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { SquareTerminal } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { useAppStore } from '../../store'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { activateCanvasTerminal } from './activate-canvas-terminal'
import CanvasTerminalCard, { type CanvasTerminalItem } from './CanvasTerminalCard'
import type { PaneCanvasToolbarTrailingInset } from './pane-canvas-toolbar-chrome'
import { PaneCanvasToolbar } from './PaneCanvasToolbar'
import { paneCanvasExtent } from './pane-canvas-extent'
import {
  arrangePaneCanvasBounds,
  PANE_CANVAS_DEFAULT_HEIGHT,
  PANE_CANVAS_DEFAULT_WIDTH,
  resolvePaneCanvasDrop,
  type PaneCanvasBounds,
  type PaneCanvasWorkspaceState
} from './pane-canvas-layout-state'
import { usePaneCanvasViewportVisibility } from './use-pane-canvas-viewport-visibility'

export default function TabGroupCanvasLayout({
  terminalItems,
  worktreeId,
  focusedTerminalTabId,
  canvasState,
  updateCanvasState,
  onVisibleTerminalTabIdsChange,
  title,
  showSplitsButton = true,
  allowTerminalCreation = true,
  toolbarContent,
  trailingChromeInset = 'window-controls',
  emptyState,
  onActivateItem,
  onTogglePinned,
  onCloseItem
}: {
  terminalItems: readonly CanvasTerminalItem[]
  /** Project Canvas has one owner; global canvases carry worktreeId per item. */
  worktreeId?: string
  focusedTerminalTabId?: string
  canvasState: PaneCanvasWorkspaceState
  updateCanvasState: (
    updater: (current: PaneCanvasWorkspaceState) => PaneCanvasWorkspaceState
  ) => void
  onVisibleTerminalTabIdsChange: (terminalTabIds: ReadonlySet<string>) => void
  title?: string
  showSplitsButton?: boolean
  allowTerminalCreation?: boolean
  toolbarContent?: ReactNode
  /** Reserve fixed titlebar controls when this surface reaches the window edge. */
  trailingChromeInset?: PaneCanvasToolbarTrailingInset
  emptyState?: ReactNode
  onActivateItem?: (item: CanvasTerminalItem) => void
  onTogglePinned?: (item: CanvasTerminalItem) => void
  onCloseItem?: (item: CanvasTerminalItem) => void
}): React.JSX.Element {
  const canvasContextPointRef = useRef({ x: 8, y: 8 })
  const canvasPanCleanupRef = useRef<(() => void) | null>(null)
  const terminalTabIds = useMemo(
    () => terminalItems.map((item) => item.terminalTabId),
    [terminalItems]
  )
  const boundsByTerminalTabId = canvasState.boundsByTerminalTabId
  const extent = paneCanvasExtent(terminalTabIds, boundsByTerminalTabId, 1280, 800)
  const viewportRef = usePaneCanvasViewportVisibility({
    terminalTabIds,
    boundsByTerminalTabId,
    onVisibleTerminalTabIdsChange
  })

  const commitBounds = useCallback(
    (terminalTabId: string, bounds: PaneCanvasBounds) => {
      updateCanvasState((current) => ({
        ...current,
        boundsByTerminalTabId: {
          ...current.boundsByTerminalTabId,
          [terminalTabId]: bounds
        }
      }))
    },
    [updateCanvasState]
  )

  const otherBoundsByTerminalTabId = useMemo<Record<string, PaneCanvasBounds[]>>(
    () =>
      Object.fromEntries(
        terminalTabIds.map((terminalTabId) => [
          terminalTabId,
          terminalTabIds
            .filter((candidateId) => candidateId !== terminalTabId)
            .map((candidateId) => boundsByTerminalTabId[candidateId])
            .filter((bounds): bounds is PaneCanvasBounds => bounds !== undefined)
        ])
      ),
    [boundsByTerminalTabId, terminalTabIds]
  )

  const activateTerminal = useCallback(
    (item: CanvasTerminalItem) => {
      if (onActivateItem) {
        onActivateItem(item)
        return
      }
      if (!worktreeId) {
        return
      }
      activateCanvasTerminal({
        worktreeId,
        groupId: item.groupId,
        unifiedTabId: item.unifiedTabId,
        terminalTabId: item.terminalTabId
      })
      const activeLeafId =
        useAppStore.getState().terminalLayoutsByTabId[item.terminalTabId]?.activeLeafId ?? null
      requestAnimationFrame(() => focusTerminalTabSurface(item.terminalTabId, activeLeafId))
    },
    [onActivateItem, worktreeId]
  )

  const leaveWorktreeIfEmpty = useCallback(() => {
    if (!worktreeId) {
      return
    }
    const store = useAppStore.getState()
    if (store.activeWorktreeId !== worktreeId) {
      return
    }
    if (store.reconcileWorktreeTabModel(worktreeId).renderableTabCount === 0) {
      store.setActiveWorktree(null)
    }
  }, [worktreeId])

  const createTerminal = useCallback(async (groupId: string): Promise<string | undefined> => {
    return await useAppStore.getState().openNewTerminalTabInActiveWorkspace(groupId)
  }, [])

  const createTerminalAt = useCallback(
    async (point: { x: number; y: number }) => {
      if (!allowTerminalCreation || !worktreeId) {
        return
      }
      const sourceGroupId =
        terminalItems.find((item) => item.terminalTabId === focusedTerminalTabId)?.groupId ??
        terminalItems[0]?.groupId ??
        useAppStore.getState().activeGroupIdByWorktree[worktreeId]
      if (!sourceGroupId) {
        return
      }
      const created = await createTerminal(sourceGroupId)
      if (!created) {
        return
      }
      updateCanvasState((current) => {
        const others = Object.entries(current.boundsByTerminalTabId)
          .filter(([id]) => id !== created)
          .map(([, bounds]) => bounds)
        let nextBounds: PaneCanvasBounds = {
          x: Math.max(0, point.x),
          y: Math.max(0, point.y),
          width: PANE_CANVAS_DEFAULT_WIDTH,
          height: PANE_CANVAS_DEFAULT_HEIGHT
        }
        nextBounds = resolvePaneCanvasDrop(nextBounds, others)
        return {
          ...current,
          boundsByTerminalTabId: { ...current.boundsByTerminalTabId, [created]: nextBounds }
        }
      })
    },
    [
      allowTerminalCreation,
      createTerminal,
      focusedTerminalTabId,
      terminalItems,
      updateCanvasState,
      worktreeId
    ]
  )

  useEffect(
    () => () => {
      canvasPanCleanupRef.current?.()
    },
    []
  )

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }
    const containBrowserZoom = (event: WheelEvent): void => {
      if (!event.ctrlKey) {
        return
      }
      // Ctrl+wheel belongs to the Canvas while the pointer is over it. Until
      // Canvas zoom is exposed deliberately, do not let Chromium shrink the
      // entire Orca UI as an accidental workaround for reaching blank space.
      event.preventDefault()
      event.stopPropagation()
    }
    viewport.addEventListener('wheel', containBrowserZoom, { passive: false })
    return () => viewport.removeEventListener('wheel', containBrowserZoom)
  }, [viewportRef])

  const beginCanvasPan = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || canvasPanCleanupRef.current) {
        return
      }
      const viewport = viewportRef.current
      if (!viewport) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const surface = event.currentTarget
      const pointerId = event.pointerId
      const start = {
        x: event.clientX,
        y: event.clientY,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop
      }
      try {
        surface.setPointerCapture(pointerId)
      } catch {
        // Window listeners keep panning alive if Chromium refuses capture.
      }
      surface.style.cursor = 'grabbing'

      const move = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId) {
          return
        }
        moveEvent.preventDefault()
        viewport.scrollLeft = start.scrollLeft - (moveEvent.clientX - start.x)
        viewport.scrollTop = start.scrollTop - (moveEvent.clientY - start.y)
      }
      let cleaned = false
      const cleanup = (): void => {
        if (cleaned) {
          return
        }
        cleaned = true
        try {
          if (surface.hasPointerCapture(pointerId)) {
            surface.releasePointerCapture(pointerId)
          }
        } catch {
          // The background can unmount during a drag.
        }
        surface.style.cursor = ''
        window.removeEventListener('pointermove', move, true)
        window.removeEventListener('pointerup', finish, true)
        window.removeEventListener('pointercancel', finish, true)
        if (canvasPanCleanupRef.current === cleanup) {
          canvasPanCleanupRef.current = null
        }
      }
      const finish = (finishEvent: PointerEvent): void => {
        if (finishEvent.pointerId === pointerId) {
          cleanup()
        }
      }
      window.addEventListener('pointermove', move, true)
      window.addEventListener('pointerup', finish, true)
      window.addEventListener('pointercancel', finish, true)
      canvasPanCleanupRef.current = cleanup
    },
    [viewportRef]
  )

  return (
    <div
      className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden border-l border-border bg-background"
      data-pane-canvas-root="true"
    >
      <div className="h-[4px] shrink-0 bg-card" data-terminal-focus-release-surface="true" />
      <PaneCanvasToolbar
        title={title}
        showSplitsButton={showSplitsButton}
        trailingChromeInset={trailingChromeInset}
        toolbarContent={toolbarContent}
        onShowSplits={() => updateCanvasState((current) => ({ ...current, mode: 'split' }))}
        onArrange={() => {
          const width = viewportRef.current?.clientWidth ?? 1280
          updateCanvasState((current) => ({
            ...current,
            boundsByTerminalTabId: arrangePaneCanvasBounds(
              terminalTabIds,
              width,
              current.boundsByTerminalTabId
            )
          }))
        }}
      />
      <div
        ref={viewportRef}
        className="scrollbar-sleek relative flex-1 min-h-0 min-w-0 overflow-auto overscroll-contain"
        data-pane-canvas-viewport="true"
        data-terminal-focus-release-surface="true"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <div
          className="relative"
          style={{ width: extent.width, height: extent.height }}
          data-pane-canvas-surface="true"
        >
          {allowTerminalCreation && worktreeId ? (
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  className="absolute inset-0 cursor-grab"
                  data-pane-canvas-background="true"
                  data-terminal-focus-release-surface="true"
                  style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                  onPointerDown={beginCanvasPan}
                  onContextMenu={(event) => {
                    const viewport = viewportRef.current
                    if (!viewport) {
                      return
                    }
                    const rect = viewport.getBoundingClientRect()
                    canvasContextPointRef.current = {
                      x: viewport.scrollLeft + event.clientX - rect.left,
                      y: viewport.scrollTop + event.clientY - rect.top
                    }
                  }}
                />
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  onSelect={() => void createTerminalAt(canvasContextPointRef.current)}
                >
                  <SquareTerminal className="size-4" />
                  {translate(
                    'auto.components.tab.group.TabGroupCanvasLayout.newTerminalHere',
                    'New terminal here'
                  )}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ) : (
            <div
              className="absolute inset-0 cursor-grab"
              data-pane-canvas-background="true"
              data-terminal-focus-release-surface="true"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              onPointerDown={beginCanvasPan}
            />
          )}
          {terminalItems.length === 0 ? emptyState : null}
          {terminalItems.map((item) => {
            const bounds = boundsByTerminalTabId[item.terminalTabId]
            if (!bounds) {
              return null
            }
            return (
              <CanvasTerminalCard
                key={item.terminalTabId}
                item={item}
                worktreeId={item.worktreeId ?? worktreeId ?? ''}
                bounds={bounds}
                otherBounds={otherBoundsByTerminalTabId[item.terminalTabId] ?? []}
                isFocused={item.terminalTabId === focusedTerminalTabId}
                onActivate={activateTerminal}
                onCreateTerminal={allowTerminalCreation && worktreeId ? createTerminal : undefined}
                onTogglePinned={onTogglePinned}
                onClose={
                  onCloseItem
                    ? () => onCloseItem(item)
                    : worktreeId
                      ? (terminalTabId) =>
                          closeTerminalTab(terminalTabId, { onClosed: leaveWorktreeIfEmpty })
                      : undefined
                }
                onCommitBounds={(nextBounds) => commitBounds(item.terminalTabId, nextBounds)}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}
