import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import type { WorkspaceSurfaceSnapshot } from '../../../../shared/maestro-workspace-canvas'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { MaestroWorkspaceCanvasResource } from '@/hooks/useMaestroWorkspaceCanvas'
import { MaestroWorkspaceWindow, type MaestroWorkspaceWindowProps } from './MaestroWorkspaceWindow'
import {
  moveWorkspaceWindow,
  resizeWorkspaceWindow,
  workspaceWindowBounds,
  type MaestroWorkspaceWindowPlacement
} from './maestro-workspace-window-layout'
import { maestroWorkspaceMutationKey } from './maestro-workspace-mutation-key'
import type { MaestroCanvasSize, MaestroCanvasViewport } from './maestro-canvas-viewport'
import { useMaestroWorkspacePresence } from './maestro-workspace-presence'
import {
  maestroWorkspacePreviewMode,
  type MaestroWorkspacePreviewMode
} from './maestro-workspace-visibility'
import type { CanvasAgentTopology } from './maestro-agent-topology'

type PlacementMap = Readonly<Record<string, MaestroWorkspaceWindowPlacement>>
type LinkDrag = {
  sourceKey: string
  targetKey: string | null
  from: { x: number; y: number }
  to: { x: number; y: number }
}
type WindowLayerProps = {
  target: RuntimeClientTarget
  resource: MaestroWorkspaceCanvasResource
  snapshot: WorkspaceSurfaceSnapshot
  surfaceKeys: readonly string[]
  pendingSurfaceKey: string | null
  placements: PlacementMap
  setPlacements: Dispatch<SetStateAction<PlacementMap>>
  selectedKey: string | null
  onSelectedKeyChange: (surfaceKey: string | null) => void
  topology: CanvasAgentTopology
  optimisticPlacements: MutableRefObject<Record<string, MaestroWorkspaceWindowPlacement>>
  automaticallyPlacedSurfaceKeys: MutableRefObject<Set<string>>
  worldStyle: React.CSSProperties
  worldZoom?: number
  viewport: MaestroCanvasViewport
  canvasSize: MaestroCanvasSize
  onRevealPlacement: (placement: MaestroWorkspaceWindowPlacement) => void
  onManualLinkCreated: (sourceKey: string, targetKey: string) => void
}

function sameRuntimeTarget(previous: RuntimeClientTarget, next: RuntimeClientTarget): boolean {
  return (
    previous.kind === next.kind &&
    (previous.kind !== 'environment' ||
      (next.kind === 'environment' && previous.environmentId === next.environmentId))
  )
}

function samePlacement(
  previous: MaestroWorkspaceWindowPlacement,
  next: MaestroWorkspaceWindowPlacement
): boolean {
  return (
    previous.position.x === next.position.x &&
    previous.position.y === next.position.y &&
    previous.size.width === next.size.width &&
    previous.size.height === next.size.height &&
    previous.collapsed === next.collapsed &&
    previous.z_order === next.z_order
  )
}

function sameWindowRender(
  previous: MaestroWorkspaceWindowProps,
  next: MaestroWorkspaceWindowProps
): boolean {
  return (
    previous.surfaceKey === next.surfaceKey &&
    previous.surface.id.unified_tab_id === next.surface.id.unified_tab_id &&
    previous.surface.revision === next.surface.revision &&
    previous.surface.title === next.surface.title &&
    previous.surface.availability === next.surface.availability &&
    samePlacement(previous.placement, next.placement) &&
    previous.selected === next.selected &&
    previous.pending === next.pending &&
    previous.linkTarget === next.linkTarget &&
    sameRuntimeTarget(previous.runtimeTarget, next.runtimeTarget) &&
    previous.worldZoom === next.worldZoom &&
    previous.presencePhase === next.presencePhase &&
    previous.previewMode === next.previewMode &&
    previous.agentFunctionLabel === next.agentFunctionLabel &&
    previous.agentTaskId === next.agentTaskId &&
    previous.agentRole === next.agentRole
  )
}

const MemoizedMaestroWorkspaceWindow = memo(MaestroWorkspaceWindow, sameWindowRender)

export function MaestroWorkspaceWindowLayer(props: WindowLayerProps): React.JSX.Element {
  const [linkDrag, setLinkDrag] = useState<LinkDrag | null>(null)
  const linkOverlayRef = useRef<SVGSVGElement | null>(null)
  const linkDragCleanupRef = useRef<(() => void) | null>(null)
  const lastPlacementsRef = useRef<Record<string, MaestroWorkspaceWindowPlacement>>({})
  const previewModesRef = useRef<Record<string, MaestroWorkspacePreviewMode>>({})
  const renderableSurfaceKeys = useMemo(
    () => new Set(Object.keys(props.placements)),
    [props.placements]
  )
  const presenceItems = useMaestroWorkspacePresence(
    props.snapshot,
    props.surfaceKeys,
    renderableSurfaceKeys
  )
  const topologyBySurfaceKey = useMemo(
    () => new Map(props.topology.nodes.map((node) => [node.surfaceId, node])),
    [props.topology.nodes]
  )
  const latestActionsRef = useRef({
    mutate: props.resource.mutate,
    onManualLinkCreated: props.onManualLinkCreated,
    onRevealPlacement: props.onRevealPlacement,
    onSelectedKeyChange: props.onSelectedKeyChange,
    surfaces: props.snapshot.surfaces
  })
  useLayoutEffect(() => {
    latestActionsRef.current = {
      mutate: props.resource.mutate,
      onManualLinkCreated: props.onManualLinkCreated,
      onRevealPlacement: props.onRevealPlacement,
      onSelectedKeyChange: props.onSelectedKeyChange,
      surfaces: props.snapshot.surfaces
    }
  }, [
    props.onManualLinkCreated,
    props.onRevealPlacement,
    props.onSelectedKeyChange,
    props.resource.mutate,
    props.snapshot.surfaces
  ])
  const mutate = useCallback<MaestroWorkspaceCanvasResource['mutate']>(
    (mutation) => latestActionsRef.current.mutate(mutation),
    []
  )
  const selectSurface = useCallback(
    (surfaceKey: string, placement: MaestroWorkspaceWindowPlacement): void => {
      latestActionsRef.current.onRevealPlacement(placement)
      latestActionsRef.current.onSelectedKeyChange(surfaceKey)
    },
    []
  )
  useEffect(() => () => linkDragCleanupRef.current?.(), [])
  useEffect(() => {
    const retainedKeys = new Set(presenceItems.map((item) => item.surfaceKey))
    for (const surfaceKey of Object.keys(lastPlacementsRef.current)) {
      if (!retainedKeys.has(surfaceKey)) {
        delete lastPlacementsRef.current[surfaceKey]
        delete previewModesRef.current[surfaceKey]
      }
    }
  }, [presenceItems])
  const beginLink = useCallback(
    (sourceKey: string, event: React.PointerEvent<HTMLButtonElement>): void => {
      if (event.button !== 0) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const overlay = linkOverlayRef.current
      if (!overlay) {
        return
      }
      linkDragCleanupRef.current?.()
      const overlayBounds = overlay.getBoundingClientRect()
      const point = {
        x: event.clientX - overlayBounds.left,
        y: event.clientY - overlayBounds.top
      }
      let hoveredTargetKey: string | null = null
      setLinkDrag({ sourceKey, targetKey: null, from: point, to: point })

      const move = (moveEvent: PointerEvent): void => {
        const target = document
          .elementFromPoint(moveEvent.clientX, moveEvent.clientY)
          ?.closest<HTMLElement>('[data-maestro-workspace-surface]')
        const candidate = target?.dataset.maestroWorkspaceSurface ?? null
        const targetKey =
          candidate && candidate !== sourceKey && latestActionsRef.current.surfaces[candidate]
            ? candidate
            : null
        hoveredTargetKey = targetKey
        setLinkDrag({
          sourceKey,
          targetKey,
          from: point,
          to: {
            x: moveEvent.clientX - overlayBounds.left,
            y: moveEvent.clientY - overlayBounds.top
          }
        })
      }
      const finish = (upEvent: PointerEvent): void => {
        cleanup()
        const target = document
          .elementFromPoint(upEvent.clientX, upEvent.clientY)
          ?.closest<HTMLElement>('[data-maestro-workspace-surface]')
        const targetKey = hoveredTargetKey ?? target?.dataset.maestroWorkspaceSurface
        if (targetKey && targetKey !== sourceKey && latestActionsRef.current.surfaces[targetKey]) {
          latestActionsRef.current.onManualLinkCreated(sourceKey, targetKey)
          void latestActionsRef.current.mutate({
            action: 'create-manual-link',
            source_surface_key: sourceKey,
            target_surface_key: targetKey,
            link_type: 'context-for',
            label: null,
            idempotency_key: maestroWorkspaceMutationKey('manual-link', `${sourceKey}:${targetKey}`)
          })
        }
        setLinkDrag(null)
      }
      const cancel = (): void => {
        cleanup()
        setLinkDrag(null)
      }
      const cleanup = (): void => {
        window.removeEventListener('pointermove', move, true)
        window.removeEventListener('pointerup', finish, true)
        window.removeEventListener('pointercancel', cancel, true)
        if (linkDragCleanupRef.current === cleanup) {
          linkDragCleanupRef.current = null
        }
      }
      window.addEventListener('pointermove', move, true)
      window.addEventListener('pointerup', finish, true)
      window.addEventListener('pointercancel', cancel, true)
      linkDragCleanupRef.current = cleanup
    },
    []
  )
  return (
    <>
      <div className="absolute" style={props.worldStyle}>
        {presenceItems.map(({ surfaceKey, surface, phase }) => {
          const currentPlacement = props.placements[surfaceKey]
          if (currentPlacement) {
            lastPlacementsRef.current[surfaceKey] = currentPlacement
          }
          const placement = currentPlacement ?? lastPlacementsRef.current[surfaceKey]
          if (!surface || !placement) {
            return null
          }
          const selected = props.selectedKey === surfaceKey && phase !== 'exiting'
          const agentNode = topologyBySurfaceKey.get(surfaceKey)
          const previewMode = maestroWorkspacePreviewMode({
            bounds: workspaceWindowBounds(placement),
            viewport: props.viewport,
            canvas: props.canvasSize,
            previous: previewModesRef.current[surfaceKey],
            selected
          })
          previewModesRef.current[surfaceKey] = previewMode
          const commitPlacement = (
            action: 'move' | 'resize',
            next: MaestroWorkspaceWindowPlacement
          ): void => {
            props.automaticallyPlacedSurfaceKeys.current.delete(surfaceKey)
            props.optimisticPlacements.current[surfaceKey] = next
            props.setPlacements((current) => ({ ...current, [surfaceKey]: next }))
            void mutate({
              action: 'set-placement',
              surface_id: surface.id,
              placement: next,
              idempotency_key: maestroWorkspaceMutationKey(action, surface.id.unified_tab_id)
            })
          }
          const key = (action: string, identity = surface.id.unified_tab_id) =>
            maestroWorkspaceMutationKey(action, identity)
          return (
            <MemoizedMaestroWorkspaceWindow
              key={surfaceKey}
              surfaceKey={surfaceKey}
              surface={surface}
              placement={placement}
              selected={selected}
              pending={props.pendingSurfaceKey === surfaceKey || phase === 'exiting'}
              linkTarget={linkDrag?.targetKey === surfaceKey}
              runtimeTarget={props.target}
              worldZoom={props.worldZoom}
              presencePhase={phase}
              previewMode={previewMode}
              agentFunctionLabel={agentNode?.functionLabel}
              agentTaskId={agentNode?.taskId}
              agentRole={
                props.topology.coordinatorSurfaceId === surfaceKey
                  ? 'coordinator'
                  : agentNode?.parentSurfaceId || agentNode?.coordinatorSurfaceId
                    ? 'worker'
                    : undefined
              }
              onSelect={() => {
                selectSurface(surfaceKey, placement)
              }}
              onRename={(title) =>
                void mutate({
                  action: 'rename',
                  surface_id: surface.id,
                  title,
                  idempotency_key: key('rename')
                })
              }
              onLinkPointerDown={(event) => beginLink(surfaceKey, event)}
              onFocus={() =>
                void mutate({
                  action: 'focus',
                  surface_id: surface.id,
                  idempotency_key: key('focus')
                })
              }
              onClose={() =>
                mutate({
                  action: 'close',
                  surface_id: surface.id,
                  idempotency_key: key('close')
                })
              }
              onMoveCommit={(delta) =>
                commitPlacement('move', moveWorkspaceWindow(placement, delta))
              }
              onResizeCommit={(delta) =>
                commitPlacement('resize', resizeWorkspaceWindow(placement, delta))
              }
              onUpdateAnnotationContent={(content) =>
                void mutate({
                  action: 'update-annotation',
                  surface_id: surface.id,
                  content,
                  tone:
                    surface.binding.kind === 'content' && surface.binding.annotation
                      ? surface.binding.annotation.tone
                      : 'observation',
                  idempotency_key: key('annotation-content')
                })
              }
            />
          )
        })}
      </div>
      <svg
        ref={linkOverlayRef}
        className="pointer-events-none absolute inset-0 z-20 size-full overflow-visible"
        aria-hidden
      >
        {linkDrag ? (
          <g data-maestro-link-drag="active">
            <path
              d={`M ${linkDrag.from.x} ${linkDrag.from.y} C ${linkDrag.from.x + 72} ${linkDrag.from.y}, ${linkDrag.to.x - 72} ${linkDrag.to.y}, ${linkDrag.to.x} ${linkDrag.to.y}`}
              fill="none"
              stroke="var(--ring)"
              strokeWidth="2"
              strokeDasharray="6 4"
            />
            <circle cx={linkDrag.from.x} cy={linkDrag.from.y} r="4" fill="var(--ring)" />
            <circle cx={linkDrag.to.x} cy={linkDrag.to.y} r="5" fill="var(--ring)" />
          </g>
        ) : null}
      </svg>
    </>
  )
}
