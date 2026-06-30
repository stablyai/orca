import { describe, expect, it } from 'vitest'
import type {
  ArchitectureDiagramLink,
  ArchitectureDiagramNode
} from '../architecture-diagram-types'
import { assignAllHandles } from './edge-routing'
import { computeEdgeBundles } from './edge-bundling'
import { autoLayoutVisibleNodes, decorateEdgesForRouting } from './architecture-layout'

function node(
  id: string,
  x: number,
  y: number,
  kind: ArchitectureDiagramNode['data']['kind'] = 'system'
): ArchitectureDiagramNode {
  return {
    id,
    type: 'architecture',
    position: { x, y },
    data: { name: id, description: '', kind, status: kind === 'person' ? undefined : 'proposed' }
  }
}

function edge(id: string, source: string, target: string, label = id): ArchitectureDiagramLink {
  return { id, source, target, data: { label } }
}

describe('architecture layout and edge routing', () => {
  it('assigns side handles by dominant node direction and spreads congested handles', () => {
    const nodes = [node('hub', 0, 0), node('right-a', 360, 0), node('right-b', 380, 140)]
    const handles = assignAllHandles(nodes, [
      edge('a', 'hub', 'right-a'),
      edge('b', 'hub', 'right-b')
    ])

    expect(handles.get('a')).toMatchObject({ sourceHandle: 'right', targetHandle: 'left' })
    expect(handles.get('b')?.sourceHandle).not.toBe(handles.get('a')?.sourceHandle)
  })

  it('computes hub bundles only when multiple edges share a cardinal magnet', () => {
    const nodes = [
      node('hub', 0, 0),
      node('right-a', 360, -80),
      node('right-b', 380, 20),
      node('right-c', 360, 120)
    ]
    const bundles = computeEdgeBundles(
      [edge('a', 'hub', 'right-a'), edge('b', 'hub', 'right-b'), edge('c', 'hub', 'right-c')],
      nodes
    )

    expect([...bundles.keys()].sort()).toEqual(['a', 'b', 'c'])
    expect(bundles.get('a')).toMatchObject({
      hubHandle: 'right',
      hubIsSource: true,
      route: [{ x: expect.any(Number), y: expect.any(Number) }]
    })
    expect(bundles.get('a')?.route[0].x).toBeGreaterThan(170)
  })

  it('decorates routed edges with handles, bundle waypoints, statuses, and bidirectional flags', () => {
    const nodes = [
      node('api', 0, 0, 'container'),
      node('worker', 360, 0, 'container'),
      node('audit', 380, 120, 'container'),
      node('billing', 380, -120, 'container')
    ]
    const decorated = decorateEdgesForRouting(nodes, [
      edge('api-worker', 'api', 'worker', 'calls'),
      edge('worker-api', 'worker', 'api', 'replies'),
      edge('api-audit', 'api', 'audit', 'logs'),
      edge('api-billing', 'api', 'billing', 'charges')
    ])

    const forward = decorated.find((candidate) => candidate.id === 'api-worker')
    const reverse = decorated.find((candidate) => candidate.id === 'worker-api')
    expect(forward).toMatchObject({
      sourceHandle: expect.any(String),
      targetHandle: expect.any(String),
      data: { _biPair: true, _status: 'proposed' }
    })
    expect(reverse).toMatchObject({ data: { _biPair: true, _status: 'proposed' } })
    expect(decorated.filter((candidate) => candidate.data?._route).length).toBeGreaterThanOrEqual(3)
  })

  it('lays out code-level nodes in a compact grid while keeping reference nodes fixed', () => {
    const input = [
      node('op-a', 1000, 1000, 'operation'),
      node('op-b', 1000, 1000, 'operation'),
      {
        ...node('external', 640, -220, 'system'),
        data: { ...node('external', 0, 0).data, _reference: true }
      }
    ]
    const laidOut = autoLayoutVisibleNodes(input, [], { codeLevel: true, fullRelayout: true })

    expect(laidOut.find((candidate) => candidate.id === 'op-a')?.position).toEqual({ x: 0, y: 0 })
    expect(laidOut.find((candidate) => candidate.id === 'op-b')?.position?.x).toBeGreaterThan(0)
    expect(laidOut.find((candidate) => candidate.id === 'external')?.position).toEqual({
      x: 640,
      y: -220
    })
  })
})
