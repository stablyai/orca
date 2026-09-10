import { describe, expect, it } from 'vitest'
import type { MaestroWorkspaceWindowPlacement } from './maestro-workspace-window-layout'
import { workspaceWindowPlacementsOverlap } from './maestro-workspace-window-layout'
import {
  layoutIncrementalMaestroWorkspaceTopology,
  type MaestroWorkspaceTopologyLayoutNode
} from './maestro-workspace-topology-layout'

const viewport = { center: { x: 0, y: 0 }, zoom: 1 }
const canvas = { width: 1200, height: 800 }
const insets = { top: 40, right: 320, bottom: 20, left: 20 }

function placement(
  x = 0,
  y = 0,
  width = 240,
  height = 160,
  zOrder = 0
): MaestroWorkspaceWindowPlacement {
  return {
    position: { x, y },
    size: { width, height },
    collapsed: false,
    z_order: zOrder
  }
}

function node(
  surfaceKey: string,
  fields: Partial<Omit<MaestroWorkspaceTopologyLayoutNode, 'surfaceKey'>> = {}
): MaestroWorkspaceTopologyLayoutNode {
  return {
    surfaceKey,
    preferredPlacement: placement(),
    ...fields
  }
}

function layout(
  nodes: readonly MaestroWorkspaceTopologyLayoutNode[],
  existingPlacements: Readonly<Record<string, MaestroWorkspaceWindowPlacement>> = {}
) {
  return layoutIncrementalMaestroWorkspaceTopology({
    nodes,
    existingPlacements,
    viewport,
    canvas,
    insets
  })
}

describe('Maestro workspace topology layout', () => {
  it('keeps a new worker near its parent when old siblings were moved far away', () => {
    const parent = placement(100, 80, 760, 530)
    const siblings = Array.from({ length: 30 }, (_, index) =>
      node(`old-${index}`, {
        parentSurfaceKey: 'coordinator',
        preferredPlacement: placement(0, 0, 760, 530)
      })
    )
    const existing = Object.fromEntries(
      siblings.map((sibling, index) => [
        sibling.surfaceKey,
        placement(20000 + index * 800, 20000, 760, 530)
      ])
    )
    const result = layout(
      [
        node('coordinator', { isCoordinator: true }),
        ...siblings,
        node('new-worker', {
          parentSurfaceKey: 'coordinator',
          preferredPlacement: placement(0, 0, 760, 530)
        })
      ],
      { coordinator: parent, ...existing }
    )
    const worker = result.placements['new-worker']
    expect(
      Math.hypot(worker.position.x - parent.position.x, worker.position.y - parent.position.y)
    ).toBeLessThanOrEqual(2281)
    expect(workspaceWindowPlacementsOverlap(worker, parent)).toBe(false)
    for (const [key, value] of Object.entries(existing)) {
      expect(result.placements[key]).toBe(value)
    }
  })
  it('keeps existing user geometry and places stable sibling layers below the parent', () => {
    const coordinatorPlacement = placement(100, 80, 320, 220, 7)
    const beta = node('worker-beta', {
      parentSurfaceKey: 'coordinator',
      functionLabel: 'Beta',
      taskIdentity: 'task-2',
      preferredPlacement: placement(0, 0, 220, 140)
    })
    const alpha = node('worker-alpha', {
      parentSurfaceKey: 'coordinator',
      functionLabel: 'Alpha',
      taskIdentity: 'task-1',
      preferredPlacement: placement(0, 0, 180, 140)
    })

    const result = layout([beta, node('coordinator', { isCoordinator: true }), alpha], {
      coordinator: coordinatorPlacement
    })

    expect(result.placements.coordinator).toBe(coordinatorPlacement)
    expect(result.automaticallyPlacedSurfaceKeys).toEqual(['worker-alpha', 'worker-beta'])
    expect(result.placements['worker-alpha'].position).toEqual({ x: 28, y: 396 })
    expect(result.placements['worker-beta'].position).toEqual({ x: 292, y: 396 })
    expect(result.collisionScanExhaustedSurfaceKeys).toEqual([])
  })

  it('fills a compact two-column child grid as siblings arrive incrementally', () => {
    const coordinatorPlacement = placement(100, 80, 320, 220, 7)
    const children = ['one', 'two', 'three', 'four'].map((surfaceKey, index) =>
      node(surfaceKey, {
        parentSurfaceKey: 'coordinator',
        functionLabel: `Function ${index + 1}`,
        preferredPlacement: placement(0, 0, 220, 140)
      })
    )
    const nodes = [node('coordinator', { isCoordinator: true }), ...children]
    let existing: Readonly<Record<string, MaestroWorkspaceWindowPlacement>> = {
      coordinator: coordinatorPlacement
    }

    for (const child of children) {
      const result = layout(
        nodes.filter(
          (candidate) =>
            candidate.surfaceKey === 'coordinator' ||
            children.indexOf(candidate) <= children.indexOf(child)
        ),
        existing
      )
      existing = { ...existing, [child.surfaceKey]: result.placements[child.surfaceKey] }
    }

    expect(existing.one.position).toEqual({ x: 8, y: 396 })
    expect(existing.two.position).toEqual({ x: 292, y: 396 })
    expect(existing.three.position).toEqual({ x: 8, y: 600 })
    expect(existing.four.position).toEqual({ x: 292, y: 600 })
  })

  it('orders roots coordinator-first and reproduces geometry across input permutations', () => {
    const nodes = [
      node('peer', { functionLabel: 'Peer' }),
      node('coordinator', { functionLabel: 'Coordinator', isCoordinator: true }),
      node('worker', {
        parentSurfaceKey: 'coordinator',
        functionLabel: 'Worker'
      })
    ]

    const first = layout(nodes)
    const second = layout(nodes.toReversed())

    expect(first).toEqual(second)
    expect(first.automaticallyPlacedSurfaceKeys).toEqual(['coordinator', 'peer', 'worker'])
  })

  it('places owned Browser and content surfaces beside their authoritative owner', () => {
    const ownerPlacement = placement(120, 100, 300, 220, 2)
    const browser = node('browser', {
      ownerSurfaceKey: 'terminal',
      functionLabel: 'Browser',
      preferredPlacement: placement(0, 0, 260, 180)
    })
    const note = node('note', {
      ownerSurfaceKey: 'terminal',
      functionLabel: 'Note',
      preferredPlacement: placement(0, 0, 200, 120)
    })

    const result = layout([note, node('terminal'), browser], { terminal: ownerPlacement })

    expect(result.automaticallyPlacedSurfaceKeys).toEqual(['browser', 'note'])
    expect(result.placements.browser.position.x).toBe(476)
    expect(result.placements.note.position.x).toBe(476)
    expect(result.placements.browser.position.y).toBeLessThan(result.placements.note.position.y)
    expect(workspaceWindowPlacementsOverlap(result.placements.browser, ownerPlacement)).toBe(false)
    expect(workspaceWindowPlacementsOverlap(result.placements.note, ownerPlacement)).toBe(false)
  })

  it('falls back deterministically for cycles, missing parents, and multiple roots', () => {
    const nodes = [
      node('cycle-b', { parentSurfaceKey: 'cycle-a' }),
      node('missing-parent', { parentSurfaceKey: 'absent' }),
      node('cycle-a', { parentSurfaceKey: 'cycle-b' }),
      node('independent')
    ]

    const first = layout(nodes)
    const second = layout(nodes.toReversed())

    expect(first).toEqual(second)
    expect(first.automaticallyPlacedSurfaceKeys).toEqual([
      'cycle-a',
      'cycle-b',
      'independent',
      'missing-parent'
    ])
    expect(first.collisionScanExhaustedSurfaceKeys).toEqual([])
    for (const surfacePlacement of Object.values(first.placements)) {
      expect(Number.isFinite(surfacePlacement.position.x)).toBe(true)
      expect(Number.isFinite(surfacePlacement.position.y)).toBe(true)
    }
  })

  it('centers an oversized root stably in a narrow viewport', () => {
    const result = layoutIncrementalMaestroWorkspaceTopology({
      nodes: [node('oversized', { preferredPlacement: placement(0, 0, 4096, 4096) })],
      existingPlacements: {},
      viewport,
      canvas: { width: 320, height: 180 },
      insets: { top: 16, right: 16, bottom: 16, left: 16 }
    })

    expect(result.placements.oversized.position).toEqual({ x: -2048, y: -2048 })
    expect(result.collisionScanExhaustedSurfaceKeys).toEqual([])
  })

  it('reports a stable fallback when the bounded collision scan is exhausted', () => {
    const blockers = {
      northWest: placement(-4096, -4096, 4096, 4096, 1),
      northEast: placement(0, -4096, 4096, 4096, 2),
      southWest: placement(-4096, 0, 4096, 4096, 3),
      southEast: placement(0, 0, 4096, 4096, 4)
    }

    const first = layout(
      [node('new-surface', { preferredPlacement: placement(0, 0, 160, 96) })],
      blockers
    )
    const second = layout(
      [node('new-surface', { preferredPlacement: placement(0, 0, 160, 96) })],
      blockers
    )

    expect(first).toEqual(second)
    expect(first.placements['new-surface'].position).toEqual({ x: -230, y: -38 })
    expect(first.collisionScanExhaustedSurfaceKeys).toEqual(['new-surface'])
  })
})
