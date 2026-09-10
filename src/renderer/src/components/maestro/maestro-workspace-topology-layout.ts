import type {
  MaestroCanvasInsets,
  MaestroCanvasSize,
  MaestroCanvasViewport
} from './maestro-canvas-viewport'
import {
  findWorkspaceWindowPlacementNearPosition,
  type MaestroWorkspaceWindowPlacement
} from './maestro-workspace-window-layout'
import { placeMaestroWorkspaceTopologyRoot } from './maestro-workspace-topology-root-placement'
import { workspacePlacementProximity } from './maestro-workspace-placement-proximity'

const TOPOLOGY_LAYER_GAP = 96
const TOPOLOGY_SIBLING_GAP = 64
const OWNED_SURFACE_GAP = 56

export type MaestroWorkspaceTopologyLayoutNode = {
  surfaceKey: string
  preferredPlacement: MaestroWorkspaceWindowPlacement
  parentSurfaceKey?: string
  ownerSurfaceKey?: string
  functionLabel?: string
  taskIdentity?: string
  isCoordinator?: boolean
}

export type MaestroWorkspaceTopologyLayoutResult = {
  placements: Readonly<Record<string, MaestroWorkspaceWindowPlacement>>
  automaticallyPlacedSurfaceKeys: readonly string[]
  collisionScanExhaustedSurfaceKeys: readonly string[]
}

type ResolvedParent = {
  surfaceKey: string
  relation: 'lineage' | 'ownership'
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareOptional(left?: string, right?: string): number {
  if (left === right) {
    return 0
  }
  if (left === undefined) {
    return 1
  }
  if (right === undefined) {
    return -1
  }
  return compareStable(left, right)
}

function compareTopologyNodes(
  left: MaestroWorkspaceTopologyLayoutNode,
  right: MaestroWorkspaceTopologyLayoutNode
): number {
  if (Boolean(left.isCoordinator) !== Boolean(right.isCoordinator)) {
    return left.isCoordinator ? -1 : 1
  }
  return (
    compareOptional(left.functionLabel, right.functionLabel) ||
    compareOptional(left.taskIdentity, right.taskIdentity) ||
    compareStable(left.surfaceKey, right.surfaceKey)
  )
}

function resolveAuthoritativeParents(
  nodesBySurfaceKey: ReadonlyMap<string, MaestroWorkspaceTopologyLayoutNode>
): Map<string, ResolvedParent> {
  const parents = new Map<string, ResolvedParent>()
  for (const node of nodesBySurfaceKey.values()) {
    if (
      node.parentSurfaceKey &&
      node.parentSurfaceKey !== node.surfaceKey &&
      nodesBySurfaceKey.has(node.parentSurfaceKey)
    ) {
      parents.set(node.surfaceKey, {
        surfaceKey: node.parentSurfaceKey,
        relation: 'lineage'
      })
      continue
    }
    if (
      node.ownerSurfaceKey &&
      node.ownerSurfaceKey !== node.surfaceKey &&
      nodesBySurfaceKey.has(node.ownerSurfaceKey)
    ) {
      parents.set(node.surfaceKey, {
        surfaceKey: node.ownerSurfaceKey,
        relation: 'ownership'
      })
    }
  }
  return parents
}

function findCycleMembers(parents: ReadonlyMap<string, ResolvedParent>): Set<string> {
  const completed = new Set<string>()
  const cycleMembers = new Set<string>()
  const surfaceKeys = [...parents.keys()].sort(compareStable)

  for (const surfaceKey of surfaceKeys) {
    const path: string[] = []
    const pathIndexes = new Map<string, number>()
    let current: string | undefined = surfaceKey
    while (current && !completed.has(current)) {
      const cycleStart = pathIndexes.get(current)
      if (cycleStart !== undefined) {
        for (const member of path.slice(cycleStart)) {
          cycleMembers.add(member)
        }
        break
      }
      pathIndexes.set(current, path.length)
      path.push(current)
      current = parents.get(current)?.surfaceKey
    }
    for (const member of path) {
      completed.add(member)
    }
  }
  return cycleMembers
}

function buildAcyclicParents(
  nodesBySurfaceKey: ReadonlyMap<string, MaestroWorkspaceTopologyLayoutNode>
): Map<string, ResolvedParent> {
  const parents = resolveAuthoritativeParents(nodesBySurfaceKey)
  for (const cycleMember of findCycleMembers(parents)) {
    parents.delete(cycleMember)
  }
  return parents
}

function orderTopologyNodes(
  nodesBySurfaceKey: ReadonlyMap<string, MaestroWorkspaceTopologyLayoutNode>,
  parents: ReadonlyMap<string, ResolvedParent>
): {
  ordered: MaestroWorkspaceTopologyLayoutNode[]
  childrenByParent: ReadonlyMap<string, MaestroWorkspaceTopologyLayoutNode[]>
} {
  const childrenByParent = new Map<string, MaestroWorkspaceTopologyLayoutNode[]>()
  const roots: MaestroWorkspaceTopologyLayoutNode[] = []
  for (const node of nodesBySurfaceKey.values()) {
    const parent = parents.get(node.surfaceKey)
    if (!parent) {
      roots.push(node)
      continue
    }
    const children = childrenByParent.get(parent.surfaceKey) ?? []
    children.push(node)
    childrenByParent.set(parent.surfaceKey, children)
  }
  roots.sort(compareTopologyNodes)
  for (const children of childrenByParent.values()) {
    children.sort(compareTopologyNodes)
  }

  const ordered: MaestroWorkspaceTopologyLayoutNode[] = []
  let layer = roots
  while (layer.length > 0) {
    ordered.push(...layer)
    layer = layer.flatMap((node) => childrenByParent.get(node.surfaceKey) ?? [])
  }
  return { ordered, childrenByParent }
}

function placementForNode(
  node: MaestroWorkspaceTopologyLayoutNode,
  placements: Readonly<Record<string, MaestroWorkspaceWindowPlacement>>
): MaestroWorkspaceWindowPlacement {
  return placements[node.surfaceKey] ?? node.preferredPlacement
}

function lineagePosition(
  node: MaestroWorkspaceTopologyLayoutNode,
  siblings: readonly MaestroWorkspaceTopologyLayoutNode[],
  parent: MaestroWorkspaceWindowPlacement,
  placements: Readonly<Record<string, MaestroWorkspaceWindowPlacement>>
): { x: number; y: number } {
  const nodePlacement = placementForNode(node, placements)
  const siblingPlacements = siblings.map((sibling) => placementForNode(sibling, placements))
  const placedSiblingCount = siblings.filter(
    (sibling) => sibling.surfaceKey !== node.surfaceKey && placements[sibling.surfaceKey]
  ).length
  const column = placedSiblingCount % 2
  const row = Math.floor(placedSiblingCount / 2)
  const columnWidth = Math.max(
    nodePlacement.size.width,
    ...siblingPlacements.map((placement) => placement.size.width)
  )
  const rowHeight = Math.max(
    nodePlacement.size.height,
    ...siblingPlacements.map((placement) => placement.size.height)
  )
  const parentCenterX = parent.position.x + parent.size.width / 2
  const columnStartX =
    column === 0
      ? parentCenterX - TOPOLOGY_SIBLING_GAP / 2 - columnWidth
      : parentCenterX + TOPOLOGY_SIBLING_GAP / 2
  return {
    x: columnStartX + (columnWidth - nodePlacement.size.width) / 2,
    y:
      parent.position.y +
      parent.size.height +
      TOPOLOGY_LAYER_GAP +
      row * (rowHeight + TOPOLOGY_SIBLING_GAP)
  }
}

function ownershipPosition(
  node: MaestroWorkspaceTopologyLayoutNode,
  siblings: readonly MaestroWorkspaceTopologyLayoutNode[],
  owner: MaestroWorkspaceWindowPlacement,
  placements: Readonly<Record<string, MaestroWorkspaceWindowPlacement>>
): { x: number; y: number } {
  const siblingPlacements = siblings.map((sibling) => placementForNode(sibling, placements))
  const totalHeight =
    siblingPlacements.reduce((height, placement) => height + placement.size.height, 0) +
    Math.max(0, siblings.length - 1) * OWNED_SURFACE_GAP
  let y = owner.position.y + owner.size.height / 2 - totalHeight / 2
  for (let index = 0; index < siblings.length; index += 1) {
    if (siblings[index].surfaceKey === node.surfaceKey) {
      break
    }
    y += siblingPlacements[index].size.height + OWNED_SURFACE_GAP
  }
  return { x: owner.position.x + owner.size.width + OWNED_SURFACE_GAP, y }
}

function viewportPosition(
  placement: MaestroWorkspaceWindowPlacement,
  viewport: MaestroCanvasViewport,
  canvas: MaestroCanvasSize,
  insets: MaestroCanvasInsets
): { x: number; y: number } {
  const usableScreenCenter = {
    x: (insets.left + canvas.width - insets.right) / 2,
    y: (insets.top + canvas.height - insets.bottom) / 2
  }
  const center = {
    x: viewport.center.x + (usableScreenCenter.x - canvas.width / 2) / viewport.zoom,
    y: viewport.center.y + (usableScreenCenter.y - canvas.height / 2) / viewport.zoom
  }
  return {
    x: center.x - placement.size.width / 2,
    y: center.y - placement.size.height / 2
  }
}

export function layoutIncrementalMaestroWorkspaceTopology({
  nodes,
  existingPlacements,
  viewport,
  canvas,
  insets
}: {
  nodes: readonly MaestroWorkspaceTopologyLayoutNode[]
  existingPlacements: Readonly<Record<string, MaestroWorkspaceWindowPlacement>>
  viewport: MaestroCanvasViewport
  canvas: MaestroCanvasSize
  insets: MaestroCanvasInsets
}): MaestroWorkspaceTopologyLayoutResult {
  const sortedNodes = [...nodes].sort(compareTopologyNodes)
  const nodesBySurfaceKey = new Map(sortedNodes.map((node) => [node.surfaceKey, node]))
  const parents = buildAcyclicParents(nodesBySurfaceKey)
  const { ordered, childrenByParent } = orderTopologyNodes(nodesBySurfaceKey, parents)
  const placements: Record<string, MaestroWorkspaceWindowPlacement> = {
    ...existingPlacements
  }
  const occupied = Object.values(existingPlacements)
  const automaticallyPlacedSurfaceKeys: string[] = []
  const collisionScanExhaustedSurfaceKeys: string[] = []

  for (const node of ordered) {
    if (Object.hasOwn(placements, node.surfaceKey)) {
      continue
    }
    const parent = parents.get(node.surfaceKey)
    const parentPlacement = parent ? placements[parent.surfaceKey] : undefined
    const siblings = parent ? (childrenByParent.get(parent.surfaceKey) ?? []) : []
    const preferredPosition =
      parent?.relation === 'ownership' && parentPlacement
        ? ownershipPosition(node, siblings, parentPlacement, placements)
        : parentPlacement
          ? lineagePosition(node, siblings, parentPlacement, placements)
          : viewportPosition(node.preferredPlacement, viewport, canvas, insets)
    const attempt = parent
      ? findWorkspaceWindowPlacementNearPosition(
          node.preferredPlacement,
          occupied,
          preferredPosition,
          parentPlacement
            ? workspacePlacementProximity(node.preferredPlacement, parentPlacement)
            : undefined
        )
      : placeMaestroWorkspaceTopologyRoot(
          node.preferredPlacement,
          occupied,
          preferredPosition,
          viewport,
          canvas,
          insets
        )
    placements[node.surfaceKey] = attempt.placement
    occupied.push(attempt.placement)
    automaticallyPlacedSurfaceKeys.push(node.surfaceKey)
    if (!attempt.collisionFree) {
      collisionScanExhaustedSurfaceKeys.push(node.surfaceKey)
    }
  }

  return {
    placements,
    automaticallyPlacedSurfaceKeys,
    collisionScanExhaustedSurfaceKeys
  }
}
