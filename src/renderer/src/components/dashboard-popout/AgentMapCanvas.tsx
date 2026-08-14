import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import { translate } from '@/i18n/i18n'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import type {
  DashboardCard,
  DashboardSleepWorkspaceArgs,
  DashboardSpawnAgentArgs
} from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentMapAgentNode, AgentMapProjectRing, AgentMapLayout } from './agent-map-layout'
import type { AgentMapFlareStatus } from './agent-map-node-metadata'
import { AgentMapScene } from './AgentMapScene'
import { agentFocusZoom, clamp, MAX_ZOOM, MIN_ZOOM } from './agent-map-canvas-zoom'
import { AgentMapViewportControls } from './AgentMapViewportControls'
import {
  agentMapAgents,
  navigableAgentMapAgents,
  nextDirectionalAgent
} from './agent-map-navigation'
import type { AgentMapViewport } from './agent-map-viewport-transition'
import { useAgentMapContextMenus } from './useAgentMapContextMenus'
import { useAgentMapCanvasSize } from './useAgentMapCanvasSize'
import { useAgentMapPointerHold } from './useAgentMapPointerHold'
import { useAgentMapMotionLayout } from './useAgentMapMotionLayout'
import { useAgentMapSelectedFocus } from './useAgentMapSelectedFocus'
import { useAgentMapViewportTransition } from './useAgentMapViewportTransition'

const AGENT_FOCUS_DURATION_MS = 240

export type AgentMapCanvasHandle = {
  fit: () => void
  focusProject: (project: AgentMapProjectRing) => void
}

type AgentMapCanvasProps = {
  layout: AgentMapLayout
  repoIconsByRepoId?: Record<string, RepoIcon | null>
  selectedPaneKey: string | null
  allowAggregation: boolean
  showOrchestrationLinks: boolean
  recentFlareStatuses: ReadonlyMap<string, AgentMapFlareStatus>
  launchableAgentsByWorktreeId?: Record<string, TuiAgent[]>
  workspaceContextMenusEnabled?: boolean
  onWorkspaceContextMenuOpenChange?: (open: boolean) => void
  onSelectAgent: (card: DashboardCard) => void
  onSpawnAgent?: (args: DashboardSpawnAgentArgs) => void
  onSleepWorkspace?: (args: DashboardSleepWorkspaceArgs) => void
}

export const AgentMapCanvas = forwardRef<AgentMapCanvasHandle, AgentMapCanvasProps>(
  function AgentMapCanvas(
    {
      layout,
      repoIconsByRepoId,
      selectedPaneKey,
      allowAggregation,
      showOrchestrationLinks,
      recentFlareStatuses,
      launchableAgentsByWorktreeId,
      workspaceContextMenusEnabled = false,
      onWorkspaceContextMenuOpenChange,
      onSelectAgent,
      onSpawnAgent,
      onSleepWorkspace
    },
    forwardedRef
  ): React.JSX.Element {
    const containerRef = useRef<HTMLDivElement>(null)
    const svgRef = useRef<SVGSVGElement>(null)
    const nodeRefs = useRef(new Map<string, SVGGElement>())
    const dragRef = useRef<{
      pointerId: number
      point: AgentMapViewport['center']
      center: AgentMapViewport['center']
      worldPerPixelX: number
      worldPerPixelY: number
    } | null>(null)
    const viewportFrameRef = useRef<number | null>(null)
    const pendingViewportRef = useRef<AgentMapViewport | null>(null)
    const interactionBoundsRef = useRef<DOMRect | null>(null)
    const hasShownProjectsRef = useRef(layout.projects.length > 0)
    const { held, hold, release: releaseHold, clearDrag } = useAgentMapPointerHold(dragRef)
    const clearInteractionBounds = useCallback(() => {
      interactionBoundsRef.current = null
    }, [])
    const size = useAgentMapCanvasSize(containerRef, clearInteractionBounds)
    const [viewport, setViewport] = useState<AgentMapViewport>({
      center: { x: layout.width / 2, y: layout.height / 2 },
      zoom: 1
    })
    const prefersReducedMotion = usePrefersReducedMotion()
    const motionLayout = useAgentMapMotionLayout(layout, prefersReducedMotion)
    const viewportRef = useRef(viewport)
    const { contextMenus, onOpenProjectContextMenu, onOpenWorkspaceContextMenu } =
      useAgentMapContextMenus({
        enabled: workspaceContextMenusEnabled,
        launchableAgentsByWorktreeId,
        onOpenChange: onWorkspaceContextMenuOpenChange,
        onSpawnAgent,
        onSleepWorkspace
      })
    const { center, zoom } = viewport
    const agents = useMemo(() => agentMapAgents(layout), [layout])
    const navigableAgents = useMemo(
      () => navigableAgentMapAgents(layout, zoom, allowAggregation, selectedPaneKey),
      [allowAggregation, layout, selectedPaneKey, zoom]
    )
    const hasProjects = layout.projects.length > 0
    const aspect = size.width / Math.max(1, size.height)
    const baseWidth = Math.max(layout.width, layout.height * aspect)
    const baseHeight = baseWidth / aspect
    const viewWidth = baseWidth / zoom
    const viewHeight = baseHeight / zoom
    const mapScale = size.width / viewWidth
    const labelScale = Math.max(1, 1 / mapScale)
    const viewBox = `${center.x - viewWidth / 2} ${center.y - viewHeight / 2} ${viewWidth} ${viewHeight}`
    const focusZoom = agentFocusZoom(layout, size.width, size.height)
    const resolveFocusZoom = useCallback((): number => {
      const bounds = containerRef.current?.getBoundingClientRect()
      return bounds && bounds.width > 0 && bounds.height > 0
        ? agentFocusZoom(layout, bounds.width, bounds.height)
        : focusZoom
    }, [focusZoom, layout])

    const commitViewport = useCallback((next: AgentMapViewport): void => {
      viewportRef.current = next
      pendingViewportRef.current = null
      interactionBoundsRef.current = null
      setViewport(next)
    }, [])
    const { animate: animateViewport, stop: stopViewportTransition } =
      useAgentMapViewportTransition({
        durationMs: AGENT_FOCUS_DURATION_MS,
        reducedMotion: prefersReducedMotion,
        onFrame: commitViewport
      })
    useAgentMapSelectedFocus({
      agents,
      selectedPaneKey,
      viewportRef,
      resolveFocusZoom,
      animateViewport,
      stopViewportTransition
    })
    const applyViewport = useCallback(
      (next: AgentMapViewport): void => {
        stopViewportTransition()
        commitViewport(next)
      },
      [commitViewport, stopViewportTransition]
    )
    const scheduleViewport = useCallback(
      (next: AgentMapViewport): void => {
        stopViewportTransition()
        viewportRef.current = next
        pendingViewportRef.current = next
        if (viewportFrameRef.current !== null) {
          return
        }
        viewportFrameRef.current = requestAnimationFrame(() => {
          viewportFrameRef.current = null
          interactionBoundsRef.current = null
          const pending = pendingViewportRef.current
          pendingViewportRef.current = null
          if (pending) {
            setViewport(pending)
          }
        })
      },
      [stopViewportTransition]
    )
    const fit = useCallback((): void => {
      applyViewport({ center: { x: layout.width / 2, y: layout.height / 2 }, zoom: 1 })
    }, [applyViewport, layout.height, layout.width])
    const focusProject = useCallback(
      (project: AgentMapProjectRing): void => {
        const projectWidth = project.radius * 2.5
        const projectHeight = project.radius * 2.5
        applyViewport({
          center: { x: project.x, y: project.y },
          zoom: clamp(
            Math.min(baseWidth / projectWidth, baseHeight / projectHeight),
            MIN_ZOOM,
            MAX_ZOOM
          )
        })
      },
      [applyViewport, baseHeight, baseWidth]
    )
    useImperativeHandle(forwardedRef, () => ({ fit, focusProject }), [fit, focusProject])

    useEffect(() => {
      if (hasProjects && !hasShownProjectsRef.current) {
        hasShownProjectsRef.current = true
        fit()
      }
    }, [fit, hasProjects])

    useEffect(
      () => () => {
        if (viewportFrameRef.current !== null) {
          cancelAnimationFrame(viewportFrameRef.current)
        }
      },
      []
    )

    const handleAgentKeyDown = useCallback(
      (event: React.KeyboardEvent<SVGGElement>, agent: AgentMapAgentNode): void => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelectAgent(agent.card)
          return
        }
        const direction =
          event.key === 'ArrowLeft'
            ? { x: -1, y: 0 }
            : event.key === 'ArrowRight'
              ? { x: 1, y: 0 }
              : event.key === 'ArrowUp'
                ? { x: 0, y: -1 }
                : event.key === 'ArrowDown'
                  ? { x: 0, y: 1 }
                  : null
        if (!direction) {
          return
        }
        event.preventDefault()
        const next = nextDirectionalAgent(agent, navigableAgents, direction)
        nodeRefs.current.get(next?.card.paneKey ?? '')?.focus()
      },
      [navigableAgents, onSelectAgent]
    )

    const zoomAt = useCallback(
      (nextZoom: number, clientX?: number, clientY?: number): void => {
        const clampedZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM)
        if (clientX === undefined || clientY === undefined) {
          applyViewport({ ...viewportRef.current, zoom: clampedZoom })
          return
        }
        const bounds =
          interactionBoundsRef.current ?? svgRef.current?.getBoundingClientRect() ?? null
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
          applyViewport({ ...viewportRef.current, zoom: clampedZoom })
          return
        }
        interactionBoundsRef.current = bounds
        const current = viewportRef.current
        const currentWidth = baseWidth / current.zoom
        const currentHeight = baseHeight / current.zoom
        const anchorX =
          current.center.x -
          currentWidth / 2 +
          ((clientX - bounds.left) / bounds.width) * currentWidth
        const anchorY =
          current.center.y -
          currentHeight / 2 +
          ((clientY - bounds.top) / bounds.height) * currentHeight
        const nextWidth = baseWidth / clampedZoom
        const nextHeight = baseHeight / clampedZoom
        const xRatio = (clientX - bounds.left) / bounds.width
        const yRatio = (clientY - bounds.top) / bounds.height
        scheduleViewport({
          center: {
            x: anchorX - (xRatio - 0.5) * nextWidth,
            y: anchorY - (yRatio - 0.5) * nextHeight
          },
          zoom: clampedZoom
        })
      },
      [applyViewport, baseHeight, baseWidth, scheduleViewport]
    )

    useEffect(() => {
      if (!hasProjects) {
        return
      }
      const svg = svgRef.current
      if (!svg) {
        return
      }
      const handleWheel = (event: WheelEvent): void => {
        event.preventDefault()
        zoomAt(
          viewportRef.current.zoom * Math.exp(-event.deltaY * 0.0015),
          event.clientX,
          event.clientY
        )
      }
      svg.addEventListener('wheel', handleWheel, { passive: false })
      return () => svg.removeEventListener('wheel', handleWheel)
    }, [hasProjects, zoomAt])

    return (
      <div ref={containerRef} className="agent-map-canvas relative min-h-0 flex-1 overflow-hidden">
        {motionLayout.projects.length === 0 ? (
          <div className="absolute inset-0 grid place-items-center text-center text-xs text-muted-foreground">
            {translate('dashboardPopout.map.empty', 'No agents match the current filters.')}
          </div>
        ) : (
          <svg
            ref={svgRef}
            className="absolute inset-0 size-full cursor-grab touch-none select-none active:cursor-grabbing"
            viewBox={viewBox}
            aria-label={translate(
              'dashboardPopout.map.canvasLabel',
              'Nested project, workspace, and agent map'
            )}
            onPointerDown={(event) => {
              if (event.button !== 0 || dragRef.current) {
                return
              }
              if (
                (event.target as Element).closest(
                  '[data-agent-map-agent], .agent-map-worktree-ring'
                )
              ) {
                return
              }
              const bounds = event.currentTarget.getBoundingClientRect()
              if (bounds.width <= 0 || bounds.height <= 0) {
                return
              }
              const current = viewportRef.current
              dragRef.current = {
                pointerId: event.pointerId,
                point: { x: event.clientX, y: event.clientY },
                center: current.center,
                worldPerPixelX: baseWidth / current.zoom / bounds.width,
                worldPerPixelY: baseHeight / current.zoom / bounds.height
              }
              hold(event.target as Element)
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current
              if (!drag) {
                releaseHold()
                return
              }
              if (drag.pointerId !== event.pointerId) {
                return
              }
              scheduleViewport({
                center: {
                  x: drag.center.x - (event.clientX - drag.point.x) * drag.worldPerPixelX,
                  y: drag.center.y - (event.clientY - drag.point.y) * drag.worldPerPixelY
                },
                zoom: viewportRef.current.zoom
              })
            }}
            onPointerUp={(event) => {
              if (clearDrag(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
            }}
            onPointerCancel={(event) => {
              clearDrag(event.pointerId)
            }}
            onLostPointerCapture={(event) => {
              clearDrag(event.pointerId)
            }}
            onPointerLeave={() => {
              if (!dragRef.current) {
                releaseHold()
              }
            }}
          >
            <AgentMapScene
              layout={motionLayout}
              repoIconsByRepoId={repoIconsByRepoId}
              zoom={zoom}
              labelScale={labelScale}
              mapScale={mapScale}
              heldProjectId={held?.projectId ?? null}
              heldWorktreeId={held?.worktreeId ?? null}
              selectedPaneKey={selectedPaneKey}
              allowAggregation={allowAggregation}
              showOrchestrationLinks={showOrchestrationLinks}
              recentFlareStatuses={recentFlareStatuses}
              launchableAgentsByWorktreeId={launchableAgentsByWorktreeId}
              nodeRefs={nodeRefs}
              onSelectAgent={onSelectAgent}
              onSpawnAgent={onSpawnAgent}
              onOpenProjectContextMenu={onOpenProjectContextMenu}
              onOpenWorkspaceContextMenu={onOpenWorkspaceContextMenu}
              onAgentKeyDown={handleAgentKeyDown}
            />
          </svg>
        )}

        <AgentMapViewportControls
          zoom={zoom}
          onFit={fit}
          onZoomIn={() => zoomAt(viewportRef.current.zoom * 1.25)}
          onZoomOut={() => zoomAt(viewportRef.current.zoom / 1.25)}
        />
        {contextMenus}
      </div>
    )
  }
)
