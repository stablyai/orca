import { describe, expect, it } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import {
  canvasAgentKey,
  canvasDocumentSchema,
  canvasProjectKey,
  canConnectCanvasNodes,
  emptyCanvasDocument,
  findCanvasNodePosition,
  removeCanvasNodes,
  type CanvasDocument,
  type CanvasNode
} from './agent-canvas-document'

const node = (id: string, kind: CanvasNode['kind']): CanvasNode => ({
  id,
  kind,
  position: { x: 0, y: 0 },
  width: 320,
  height: 240,
  title: id,
  content: ''
})
const document = (): CanvasDocument => ({
  ...emptyCanvasDocument(),
  nodes: [node('note', 'note'), node('a', 'agent'), node('b', 'agent')]
})

describe('canvas document contracts', () => {
  it('places new nodes below occupied space without moving existing nodes', () => {
    const existing = node('note', 'note')
    expect(findCanvasNodePosition([existing], { x: 0, y: 0 }, existing)).toEqual({ x: 0, y: 304 })
    expect(findCanvasNodePosition([existing], { x: 400, y: 0 }, existing)).toEqual({ x: 400, y: 0 })
    expect(existing.position).toEqual({ x: 0, y: 0 })
  })
  it('keeps the same pane on different hosts in different identities and projects', () => {
    const first = {
      executionHostId: 'local',
      repoId: 'repo',
      worktreeId: 'folder:one',
      paneKey: 'pane'
    } as DashboardCard
    const second = { ...first, executionHostId: 'ssh:server' } as DashboardCard
    expect(canvasAgentKey(first)).not.toBe(canvasAgentKey(second))
    expect(canvasProjectKey(first)).not.toBe(canvasProjectKey(second))
  })
  it('allows context handoffs to agents and conversational cycles, but not self-links or note targets', () => {
    const value = document()
    value.edges.push({ id: 'ab', source: 'a', target: 'b' })
    expect(canConnectCanvasNodes(value, 'note', 'a')).toBe(true)
    expect(canConnectCanvasNodes(value, 'b', 'a')).toBe(true)
    expect(canConnectCanvasNodes(value, 'a', 'a')).toBe(false)
    expect(canConnectCanvasNodes(value, 'a', 'note')).toBe(false)
    expect(canConnectCanvasNodes(value, 'a', 'b')).toBe(false)
  })
  it('removes only incident connections when removing a placement', () => {
    const value = document()
    value.edges = [
      { id: 'na', source: 'note', target: 'a' },
      { id: 'nb', source: 'note', target: 'b' }
    ]
    const next = removeCanvasNodes(value, new Set(['a']))
    expect(next.nodes.map((item) => item.id)).toEqual(['note', 'b'])
    expect(next.edges).toEqual([{ id: 'nb', source: 'note', target: 'b' }])
    expect(value.nodes).toHaveLength(3)
  })
  it('rejects unsupported versions, non-finite geometry, and dangling connections', () => {
    expect(canvasDocumentSchema.safeParse({ ...document(), version: 2 }).success).toBe(false)
    expect(
      canvasDocumentSchema.safeParse({ ...document(), viewport: { x: Infinity, y: 0, zoom: 1 } })
        .success
    ).toBe(false)
    expect(
      canvasDocumentSchema.safeParse({
        ...document(),
        edges: [{ id: 'bad', source: 'missing', target: 'a' }]
      }).success
    ).toBe(false)
  })
  it('rejects duplicate identities and edges on restore', () => {
    const value = document()
    expect(
      canvasDocumentSchema.safeParse({ ...value, nodes: [...value.nodes, value.nodes[0]] }).success
    ).toBe(false)
    value.edges = [
      { id: 'first', source: 'note', target: 'a' },
      { id: 'second', source: 'note', target: 'a' }
    ]
    expect(canvasDocumentSchema.safeParse(value).success).toBe(false)
  })
})
