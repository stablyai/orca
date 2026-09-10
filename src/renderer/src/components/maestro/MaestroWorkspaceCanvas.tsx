import { Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { workspaceSurfaceKey } from '../../../../shared/maestro-workspace-canvas'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { useMaestroWorkspaceCanvas } from '@/hooks/useMaestroWorkspaceCanvas'
import {
  MaestroWorkspaceLinks,
  replaceOptimisticMaestroManualLink,
  unconfirmedOptimisticMaestroManualLinks,
  type OptimisticMaestroManualLink
} from './MaestroWorkspaceLinks'
import { MaestroWorkspaceHarnessOverlay } from './MaestroWorkspaceHarnessOverlay'
import {
  placeWorkspaceWindowAtCanvasPoint,
  workspaceWindowBounds,
  type MaestroWorkspaceWindowPlacement
} from './maestro-workspace-window-layout'
import { useMaestroWorkspaceViewport } from './useMaestroWorkspaceViewport'
import { translate } from '@/i18n/i18n'
import { MaestroWorkspaceToolbar } from './MaestroWorkspaceToolbar'
import { MaestroWorkspaceContextMenu } from './MaestroWorkspaceContextMenu'
import { MaestroWorkspaceWindowLayer } from './MaestroWorkspaceWindowLayer'
import {
  useMaestroWorkspaceHumanRunProgress,
  useMaestroWorkspaceProjection
} from './useMaestroWorkspaceRunProgress'
import { useMaestroWorkspaceAgentTopology } from './useMaestroWorkspaceAgentTopology'
import { buildMaestroWorkspaceTopologyLayoutNodes } from './maestro-workspace-topology-layout-input'
import {
  MAESTRO_REVEAL_INSETS,
  useMaestroWorkspaceAutomaticPlacement
} from './useMaestroWorkspaceAutomaticPlacement'
import {
  clearMaestroWorkspaceCanvasFocus,
  useMaestroWorkspaceSelection
} from './useMaestroWorkspaceSelection'
import {
  initialMaestroWorkspacePlacements,
  sameMaestroWorkspacePlacementGeometry
} from './maestro-workspace-placement-state'
import { useMaestroRunPanelVisibility } from './maestro-run-panel-visibility'
import { useMaestroRunReferenceActivation } from './maestro-run-reference-activation'
import { useMaestroHumanReview } from './useMaestroHumanReview'

export function MaestroWorkspaceCanvas({
  target,
  scope
}: {
  target: NonNullable<Parameters<typeof useMaestroWorkspaceCanvas>[0]>
  scope: NonNullable<Parameters<typeof useMaestroWorkspaceCanvas>[1]>
}): React.JSX.Element {
  const resource = useMaestroWorkspaceCanvas(target, scope)
  const result = resource.result
  const surfaceKeys = useMemo(
    () => (result ? Object.keys(result.snapshot.surfaces).sort() : []),
    [result]
  )
  const [placements, setPlacements] = useState<
    Readonly<Record<string, MaestroWorkspaceWindowPlacement>>
  >({})
  const [optimisticManualLinks, setOptimisticManualLinks] = useState<
    readonly OptimisticMaestroManualLink[]
  >([])
  const contextMenuWorldPoint = useRef<{ x: number; y: number } | null>(null)
  const optimisticPlacements = useRef<Record<string, MaestroWorkspaceWindowPlacement>>({})
  const automaticallyPlacedSurfaceKeys = useRef(new Set<string>())
  const projection = useMaestroWorkspaceProjection(target, scope)
  const humanRunProgress = useMaestroWorkspaceHumanRunProgress(target, scope)
  const agentTopology = useMaestroWorkspaceAgentTopology(result?.snapshot ?? null, projection)
  const runProgress = humanRunProgress ?? projection?.runProgress ?? null
  const humanReview = useMaestroHumanReview(target, projection)
  const [runPanelVisibility, setRunPanelVisibility] = useMaestroRunPanelVisibility(scope)
  const topologyLayoutNodes = useMemo(
    () =>
      result
        ? buildMaestroWorkspaceTopologyLayoutNodes({
            snapshot: result.snapshot,
            document: result.canvas.document,
            surfaceKeys,
            topology: agentTopology
          })
        : [],
    [agentTopology, result, surfaceKeys]
  )

  useEffect(() => {
    if (!result) {
      return
    }
    const authoritative = initialMaestroWorkspacePlacements(
      result.canvas.document,
      result.snapshot,
      surfaceKeys
    )
    setPlacements(() =>
      Object.fromEntries(
        surfaceKeys.map((surfaceKey) => {
          const optimistic = optimisticPlacements.current[surfaceKey]
          const confirmed = authoritative[surfaceKey]
          if (!optimistic || !confirmed) {
            return [surfaceKey, confirmed]
          }
          if (sameMaestroWorkspacePlacementGeometry(optimistic, confirmed)) {
            delete optimisticPlacements.current[surfaceKey]
            return [surfaceKey, confirmed]
          }
          if (
            resource.mutation?.status === 'stale' ||
            resource.mutation?.status === 'cancelled' ||
            resource.mutation?.status === 'unavailable'
          ) {
            delete optimisticPlacements.current[surfaceKey]
            return [surfaceKey, confirmed]
          }
          return [surfaceKey, optimistic]
        })
      )
    )
  }, [resource.mutation?.status, result, surfaceKeys])

  useEffect(() => {
    setOptimisticManualLinks((current) =>
      unconfirmedOptimisticMaestroManualLinks(current, result?.canvas.document.manual_links ?? [])
    )
  }, [result?.canvas.document.manual_links])

  const visibleOptimisticManualLinks =
    resource.mutation?.status === 'stale' ||
    resource.mutation?.status === 'cancelled' ||
    resource.mutation?.status === 'unavailable' ||
    resource.mutation?.status === 'outcome_unknown'
      ? []
      : optimisticManualLinks

  const selection = useMaestroWorkspaceSelection({
    surfaceKeys,
    manualLinks: result?.canvas.document.manual_links ?? [],
    mutate: resource.mutate
  })

  const pendingSurfaceKey = useMemo(
    () =>
      resource.mutation &&
      (resource.mutation.status === 'outcome_unknown' || resource.mutation.status === 'cancelled')
        ? resource.mutation.surface_id
          ? workspaceSurfaceKey(resource.mutation.surface_id)
          : null
        : null,
    [resource.mutation]
  )
  const board = useMaestroWorkspaceViewport({
    canvasRevision: result?.canvas.revision ?? 0,
    persisted: result?.canvas.document.viewport,
    placements,
    resource,
    mutationIdentity: scope.workspace_key
  })
  useMaestroWorkspaceAutomaticPlacement({
    result,
    resource,
    scope,
    surfaceKeys,
    nodes: topologyLayoutNodes,
    placements,
    setPlacements,
    optimisticPlacements,
    automaticallyPlacedSurfaceKeys,
    board
  })
  const activateRunReference = useMaestroRunReferenceActivation({
    topology: agentTopology,
    placements,
    snapshot: result?.snapshot,
    reveal: board.reveal,
    selectSurface: selection.selectSurface,
    mutate: resource.mutate
  })

  if (!result && resource.status === 'loading') {
    return (
      <main className="flex size-full items-center justify-center bg-background" aria-live="polite">
        <Loader2 className="mr-2 size-4 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {translate(
            'auto.components.maestro.MaestroWorkspaceCanvas.0e5b5d9947',
            'Loading workspace resources…'
          )}
        </p>
      </main>
    )
  }

  if (!result) {
    return (
      <main
        className="flex size-full items-center justify-center bg-background p-6"
        aria-live="polite"
      >
        <section className="max-w-md text-center">
          <h1 className="text-sm font-medium">
            {translate(
              'auto.components.maestro.MaestroWorkspaceCanvas.a45c57a610',
              'Workspace Canvas unavailable'
            )}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {resource.unavailableReason === 'update-required'
              ? translate(
                  'auto.components.maestro.MaestroWorkspaceCanvas.1dd7a6a069',
                  'Update the remote Orca host to view this workspace.'
                )
              : translate(
                  'auto.components.maestro.MaestroWorkspaceCanvas.799110bdc4',
                  'The workspace authority is unreachable. No resource was treated as exited.'
                )}
          </p>
          <Button
            className="mt-4"
            size="sm"
            variant="outline"
            onClick={() => void resource.refresh()}
          >
            <RefreshCw />{' '}
            {translate('auto.components.maestro.MaestroWorkspaceCanvas.48149211a4', 'Retry')}
          </Button>
        </section>
      </main>
    )
  }

  const snapshot = result.snapshot
  const document = result.canvas.document
  return (
    <main
      className="relative size-full overflow-hidden bg-background"
      data-maestro-workspace-canvas=""
      data-authority-state={resource.status}
      ref={board.rootRef}
      onKeyDown={selection.onKeyDown}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="absolute inset-0 touch-none cursor-grab active:cursor-grabbing"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--background) 96%, var(--foreground))',
              backgroundImage:
                'linear-gradient(to right, color-mix(in srgb, var(--foreground) 8%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in srgb, var(--foreground) 8%, transparent) 1px, transparent 1px)',
              ...board.canvasStyle
            }}
            ref={board.canvasRef}
            onWheel={board.onWheel}
            onPointerDown={(event) => {
              if (event.button === 0 && event.target === event.currentTarget) {
                selection.clearSelection()
                clearMaestroWorkspaceCanvasFocus()
              }
              if (event.button === 2) {
                contextMenuWorldPoint.current = board.clientPointToWorld({
                  x: event.clientX,
                  y: event.clientY
                })
              }
              board.onPointerDown(event)
            }}
            onPointerMove={board.onPointerMove}
            onPointerUp={board.onPointerUp}
            onPointerCancel={board.onPointerUp}
            onContextMenuCapture={(event) => {
              contextMenuWorldPoint.current = board.clientPointToWorld({
                x: event.clientX,
                y: event.clientY
              })
            }}
          />
        </ContextMenuTrigger>
        <MaestroWorkspaceContextMenu
          resource={resource}
          workspaceKey={scope.workspace_key}
          placementFor={(surfaceType) => {
            const point = contextMenuWorldPoint.current ?? board.viewport.center
            const size =
              surfaceType === 'terminal'
                ? { width: 760, height: 530 }
                : surfaceType === 'browser'
                  ? { width: 680, height: 480 }
                  : { width: 440, height: 360 }
            const zOrder = Math.min(
              1_000_000,
              Math.max(0, ...Object.values(placements).map((placement) => placement.z_order + 1))
            )
            return placeWorkspaceWindowAtCanvasPoint(
              {
                position: point,
                size,
                collapsed: false,
                z_order: zOrder
              },
              point,
              board.viewport,
              board.size,
              MAESTRO_REVEAL_INSETS
            )
          }}
        />
      </ContextMenu>
      <MaestroWorkspaceToolbar board={board} />

      {resource.status === 'unavailable' ? (
        <div className="absolute left-3 right-3 top-14 z-30 flex items-center justify-center gap-2 rounded-md border border-destructive/50 bg-card px-3 py-2 text-center text-xs font-medium text-destructive shadow-xs">
          <TriangleAlert className="size-3.5 shrink-0" />
          {translate(
            'auto.components.maestro.MaestroWorkspaceCanvas.ac3e558e63',
            'Authority unavailable. Last-known resources remain unverifiable.'
          )}
        </div>
      ) : null}
      {resource.mutation?.status === 'cancelled' ||
      resource.mutation?.status === 'outcome_unknown' ? (
        <div className="absolute bottom-3 left-3 z-40 rounded-md border border-border bg-card px-3 py-2 text-xs shadow-xs">
          {resource.mutation.status === 'cancelled'
            ? translate(
                'auto.components.maestro.MaestroWorkspaceCanvas.d4d2b3932b',
                'The action was cancelled. The window remains open.'
              )
            : translate(
                'auto.components.maestro.MaestroWorkspaceCanvas.d4bfd06870',
                'The outcome is unknown. The window remains until authority confirms it.'
              )}
        </div>
      ) : null}
      {resource.mutation?.status === 'unavailable' ? (
        <div className="absolute bottom-3 left-3 z-40 rounded-md border border-border bg-card px-3 py-2 text-xs shadow-xs">
          {resource.mutation.reason ??
            translate(
              'auto.components.maestro.MaestroWorkspaceCanvas.5036690f36',
              'This action is unavailable from the workspace authority.'
            )}
        </div>
      ) : null}

      {!surfaceKeys.length ? (
        <section className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 pt-16 text-center">
          <div className="max-w-sm">
            <h1 className="text-sm font-medium">
              {translate(
                'auto.components.maestro.MaestroWorkspaceCanvas.402ed16622',
                'No workspace resources yet'
              )}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {translate(
                'auto.components.maestro.MaestroWorkspaceCanvas.1605610d90',
                'Right-click the board to add a Terminal, Browser, or annotation. A Harness Run is optional.'
              )}
            </p>
          </div>
        </section>
      ) : null}

      <MaestroWorkspaceLinks
        snapshot={snapshot}
        document={document}
        placements={placements}
        optimisticManualLinks={visibleOptimisticManualLinks}
        selectedSurfaceKey={selection.selectedSurfaceKey}
        selectedManualLinkId={selection.selectedManualLinkId}
        onManualLinkSelect={selection.selectManualLink}
        onManualLinkDelete={selection.deleteManualLink}
        topology={agentTopology}
        style={board.worldStyle}
      />
      <MaestroWorkspaceWindowLayer
        target={target}
        resource={resource}
        snapshot={snapshot}
        surfaceKeys={surfaceKeys}
        pendingSurfaceKey={pendingSurfaceKey}
        placements={placements}
        setPlacements={setPlacements}
        selectedKey={selection.selectedSurfaceKey}
        onSelectedKeyChange={selection.selectSurface}
        topology={agentTopology}
        optimisticPlacements={optimisticPlacements}
        automaticallyPlacedSurfaceKeys={automaticallyPlacedSurfaceKeys}
        worldStyle={board.worldStyle}
        worldZoom={board.viewport.zoom}
        viewport={board.viewport}
        canvasSize={board.size}
        onManualLinkCreated={(source, targetKey) =>
          setOptimisticManualLinks((current) =>
            replaceOptimisticMaestroManualLink(current, source, targetKey)
          )
        }
        onRevealPlacement={(placement) =>
          board.reveal(workspaceWindowBounds(placement), MAESTRO_REVEAL_INSETS)
        }
      />
      {runProgress ? (
        <MaestroWorkspaceHarnessOverlay
          progress={runProgress}
          authorityUnavailable={resource.status === 'unavailable'}
          visibility={runPanelVisibility}
          onVisibilityChange={setRunPanelVisibility}
          onActivateReference={activateRunReference}
          humanReview={humanReview}
        />
      ) : null}
    </main>
  )
}
