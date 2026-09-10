import { memo } from 'react'
import type {
  WorkspaceCanvasDocument,
  WorkspaceCanvasManualLink
} from '../../../../shared/maestro-document-contract'
import type { WorkspaceSurfaceSnapshot } from '../../../../shared/maestro-workspace-canvas'
import type { CanvasAgentRelation, CanvasAgentTopology } from './maestro-agent-topology'
import type { MaestroWorkspaceWindowPlacement } from './maestro-workspace-window-layout'
import { translate } from '@/i18n/i18n'
import { MaestroWorkspaceLinkArtwork, MaestroWorkspaceManualLink } from './MaestroWorkspaceLink'

export type MaestroWorkspaceLinkKind = CanvasAgentRelation['kind'] | 'manual' | 'automatic'
export type MaestroWorkspaceLinkLine = {
  id: string
  source: string
  target: string
  kind: MaestroWorkspaceLinkKind
  provenance: 'manual' | 'automatic' | CanvasAgentRelation['provenance']
  deletable: boolean
}

export type OptimisticMaestroManualLink = Pick<MaestroWorkspaceLinkLine, 'id' | 'source' | 'target'>
const NO_OPTIMISTIC_MANUAL_LINKS: readonly OptimisticMaestroManualLink[] = []

export function replaceOptimisticMaestroManualLink(
  current: readonly OptimisticMaestroManualLink[],
  source: string,
  target: string
): readonly OptimisticMaestroManualLink[] {
  return [
    ...current.filter((link) => link.source !== source || link.target !== target),
    { id: crypto.randomUUID(), source, target }
  ]
}

function relationEndpoint(
  relation: Pick<CanvasAgentRelation, 'sourceSurfaceId' | 'targetSurfaceId'>
) {
  return `${relation.sourceSurfaceId}\0${relation.targetSurfaceId}`
}

export function maestroWorkspaceLinkEndpointPair(source: string, target: string): string {
  return source < target ? `${source}\0${target}` : `${target}\0${source}`
}

export function unconfirmedOptimisticMaestroManualLinks(
  optimisticLinks: readonly OptimisticMaestroManualLink[],
  confirmedLinks: readonly WorkspaceCanvasManualLink[]
): readonly OptimisticMaestroManualLink[] {
  const confirmedPairs = new Set(
    confirmedLinks.map((link) =>
      maestroWorkspaceLinkEndpointPair(link.source_surface_key, link.target_surface_key)
    )
  )
  return optimisticLinks.filter(
    (link) => !confirmedPairs.has(maestroWorkspaceLinkEndpointPair(link.source, link.target))
  )
}

function topologyLines(topology: CanvasAgentTopology): MaestroWorkspaceLinkLine[] {
  const semanticEndpoints = new Set(
    topology.relations
      .filter((relation) => relation.kind !== 'coordinates')
      .map((relation) => relationEndpoint(relation))
  )
  return topology.relations.flatMap((relation) =>
    relation.kind === 'coordinates' && semanticEndpoints.has(relationEndpoint(relation))
      ? []
      : [
          {
            id: relation.id,
            source: relation.sourceSurfaceId,
            target: relation.targetSurfaceId,
            kind: relation.kind,
            provenance: relation.provenance,
            deletable: false
          }
        ]
  )
}

function linkLines(
  snapshot: WorkspaceSurfaceSnapshot,
  document: WorkspaceCanvasDocument,
  topology: CanvasAgentTopology,
  optimisticManualLinks: readonly OptimisticMaestroManualLink[]
): MaestroWorkspaceLinkLine[] {
  const topologyLinks = topologyLines(topology)
  const manualPairs = new Set<string>()
  const manualLinks: MaestroWorkspaceLinkLine[] = document.manual_links.flatMap((link) => {
    const pair = maestroWorkspaceLinkEndpointPair(link.source_surface_key, link.target_surface_key)
    if (manualPairs.has(pair)) {
      return []
    }
    manualPairs.add(pair)
    return [
      {
        id: link.id,
        source: link.source_surface_key,
        target: link.target_surface_key,
        kind: 'manual',
        provenance: 'manual',
        deletable: true
      }
    ]
  })
  const optimisticLinks: MaestroWorkspaceLinkLine[] = optimisticManualLinks.flatMap((link) => {
    const pair = maestroWorkspaceLinkEndpointPair(link.source, link.target)
    if (manualPairs.has(pair)) {
      return []
    }
    manualPairs.add(pair)
    return [
      {
        ...link,
        kind: 'manual' as const,
        provenance: 'manual' as const,
        deletable: false
      }
    ]
  })
  const delegatedPairs = new Set(
    topologyLinks
      .filter((link) => link.kind === 'delegates')
      .map((link) => maestroWorkspaceLinkEndpointPair(link.source, link.target))
  )
  return [
    ...manualLinks,
    ...optimisticLinks,
    ...snapshot.automatic_links
      .filter(
        (link) =>
          !manualPairs.has(
            maestroWorkspaceLinkEndpointPair(link.source_surface_key, link.target_surface_key)
          ) &&
          (link.link_type !== 'parent-child' ||
            !delegatedPairs.has(
              maestroWorkspaceLinkEndpointPair(link.source_surface_key, link.target_surface_key)
            ))
      )
      .map((link) => ({
        id: link.id,
        source: link.source_surface_key,
        target: link.target_surface_key,
        kind: 'automatic' as const,
        provenance: 'automatic' as const,
        deletable: false
      })),
    ...topologyLinks.filter(
      (link) => !manualPairs.has(maestroWorkspaceLinkEndpointPair(link.source, link.target))
    )
  ]
}

function center(placement: MaestroWorkspaceWindowPlacement): { x: number; y: number } {
  return {
    x: placement.position.x + placement.size.width / 2,
    y: placement.position.y + placement.size.height / 2
  }
}

function edgeAnchor(
  placement: MaestroWorkspaceWindowPlacement,
  toward: { x: number; y: number }
): { x: number; y: number } {
  const origin = center(placement)
  const delta = { x: toward.x - origin.x, y: toward.y - origin.y }
  if (delta.x === 0 && delta.y === 0) {
    return { x: origin.x + placement.size.width / 2, y: origin.y }
  }
  const xScale =
    delta.x === 0 ? Number.POSITIVE_INFINITY : placement.size.width / 2 / Math.abs(delta.x)
  const yScale =
    delta.y === 0 ? Number.POSITIVE_INFINITY : placement.size.height / 2 / Math.abs(delta.y)
  const scale = Math.min(xScale, yScale)
  return { x: origin.x + delta.x * scale, y: origin.y + delta.y * scale }
}

function linkGeometry(
  source: MaestroWorkspaceWindowPlacement,
  target: MaestroWorkspaceWindowPlacement
): { path: string; label: { x: number; y: number } } {
  const sourceCenter = center(source)
  const targetCenter = center(target)
  const from = edgeAnchor(source, targetCenter)
  const to = edgeAnchor(target, sourceCenter)
  const horizontal = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
  const path = horizontal
    ? `M ${from.x} ${from.y} C ${(from.x + to.x) / 2} ${from.y}, ${(from.x + to.x) / 2} ${to.y}, ${to.x} ${to.y}`
    : `M ${from.x} ${from.y} C ${from.x} ${(from.y + to.y) / 2}, ${to.x} ${(from.y + to.y) / 2}, ${to.x} ${to.y}`
  return { path, label: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 } }
}

function linkPresentation(kind: MaestroWorkspaceLinkKind): {
  label: string | null
  width: number
  dash?: string
  opacity: number
} {
  if (kind === 'coordinates') {
    return { label: null, width: 1, dash: '3 6', opacity: 0.38 }
  }
  const labels: Record<Exclude<MaestroWorkspaceLinkKind, 'coordinates'>, string> = {
    delegates: translate('auto.components.maestro.links.delegates', 'Delegates'),
    'depends-on': translate('auto.components.maestro.links.dependsOn', 'Depends on'),
    'reports-to': translate('auto.components.maestro.links.reportsTo', 'Reports to'),
    'context-for': translate('auto.components.maestro.links.contextFor', 'Context'),
    manual: translate('auto.components.maestro.MaestroWorkspaceInspector.812d58dbea', 'Manual'),
    automatic: translate(
      'auto.components.maestro.MaestroWorkspaceInspector.07e9ddcb64',
      'Automatic'
    )
  }
  const patterns: Partial<Record<MaestroWorkspaceLinkKind, string>> = {
    'depends-on': '7 4',
    'reports-to': '2 4',
    'context-for': '5 5',
    automatic: '8 4'
  }
  return {
    label: labels[kind],
    width: kind === 'delegates' || kind === 'manual' ? 1.75 : 1.4,
    dash: patterns[kind],
    opacity: kind === 'delegates' ? 0.76 : 0.68
  }
}

export type MaestroWorkspaceLinkGeometry = ReturnType<typeof linkGeometry>
export type MaestroWorkspaceLinkPresentation = ReturnType<typeof linkPresentation>

export const MaestroWorkspaceLinks = memo(function MaestroWorkspaceLinks({
  snapshot,
  document,
  placements,
  topology,
  optimisticManualLinks = NO_OPTIMISTIC_MANUAL_LINKS,
  selectedSurfaceKey,
  selectedManualLinkId,
  onManualLinkSelect,
  onManualLinkDelete,
  style
}: {
  snapshot: WorkspaceSurfaceSnapshot
  document: WorkspaceCanvasDocument
  placements: Readonly<Record<string, MaestroWorkspaceWindowPlacement>>
  topology: CanvasAgentTopology
  optimisticManualLinks?: readonly OptimisticMaestroManualLink[]
  selectedSurfaceKey?: string | null
  selectedManualLinkId?: string | null
  onManualLinkSelect?: (linkId: string) => void
  onManualLinkDelete?: (linkId: string) => void
  style?: React.CSSProperties
}): React.JSX.Element {
  return (
    <svg
      className="pointer-events-none absolute overflow-visible"
      style={style}
      role="group"
      aria-label={translate('auto.components.maestro.links.group', 'Workspace links')}
    >
      {linkLines(snapshot, document, topology, optimisticManualLinks).map((link) => {
        const source = placements[link.source]
        const target = placements[link.target]
        if (!source || !target) {
          return null
        }
        const incident = selectedSurfaceKey === link.source || selectedSurfaceKey === link.target
        const presentation = linkPresentation(link.kind)
        const geometry = linkGeometry(source, target)
        const selected = link.deletable && selectedManualLinkId === link.id
        const dimmed = Boolean(
          (selectedSurfaceKey && !incident) || (selectedManualLinkId && !selected)
        )
        if (link.deletable && onManualLinkSelect && onManualLinkDelete) {
          const sourceTitle = snapshot.surfaces[link.source]?.title ?? link.source
          const targetTitle = snapshot.surfaces[link.target]?.title ?? link.target
          const accessibleLabel = translate(
            'auto.components.maestro.links.manualAccessibleLabel',
            'Manual link from {{value0}} to {{value1}}',
            { value0: sourceTitle, value1: targetTitle }
          )
          return (
            <MaestroWorkspaceManualLink
              key={`${link.provenance}:${link.id}`}
              link={link}
              geometry={geometry}
              presentation={presentation}
              selected={selected}
              dimmed={dimmed}
              accessibleLabel={accessibleLabel}
              onSelect={() => onManualLinkSelect(link.id)}
              onDelete={() => onManualLinkDelete(link.id)}
            />
          )
        }
        return (
          <g
            key={`${link.provenance}:${link.id}`}
            data-link-provenance={link.provenance}
            data-link-kind={link.kind}
            data-link-source={link.source}
            data-link-target={link.target}
            data-link-selected={incident ? 'true' : undefined}
            aria-hidden
          >
            <title>
              {presentation.label ??
                translate('auto.components.maestro.links.coordinates', 'Coordinates')}
            </title>
            <MaestroWorkspaceLinkArtwork
              kind={link.kind}
              geometry={geometry}
              presentation={presentation}
              incident={incident}
              selected={false}
              dimmed={dimmed}
            />
          </g>
        )
      })}
    </svg>
  )
})
