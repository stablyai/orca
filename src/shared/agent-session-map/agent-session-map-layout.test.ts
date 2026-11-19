import { describe, expect, it } from 'vitest'
import type { AgentMap, AgentMapNode } from './agent-session-map-model'
import { layoutAgentMap, type AgentMapLayout } from './agent-session-map-layout'

function pos(layout: AgentMapLayout, id: string): { x: number; y: number } {
  const position = layout.positions.get(id)
  if (position === undefined) {
    throw new Error(`expected a position for ${id}`)
  }
  return position
}

function node(id: string, kind: AgentMapNode['kind'] = 'subagent'): AgentMapNode {
  return {
    id,
    kind,
    label: id,
    firstTs: 0,
    lastTs: 1,
    toolCalls: [],
    turns: [],
    requests: [],
    promptCount: 0,
    filesTouched: []
  }
}

function map(nodes: AgentMapNode[], edges: AgentMap['edges']): AgentMap {
  return { rootId: 'root', nodes, edges, timeline: [] }
}

describe('layoutAgentMap', () => {
  it('centers a lone root and reports zero height beyond padding', () => {
    const layout = layoutAgentMap(map([node('root', 'main')], []), 800)
    const root = pos(layout, 'root')
    expect(root.x).toBe(400)
    // Center y = padding + half the node height.
    expect(root.y).toBe(48 + 56 / 2)
    expect(layout.edges).toEqual([])
  })

  it('spreads root children in a row and centers the root above them', () => {
    const m = map(
      [node('root', 'main'), node('a'), node('b'), node('c')],
      [
        { from: 'root', to: 'a', spawnedAt: 0 },
        { from: 'root', to: 'b', spawnedAt: 0 },
        { from: 'root', to: 'c', spawnedAt: 0 }
      ]
    )
    const layout = layoutAgentMap(m, 800)
    const root = pos(layout, 'root')
    const a = pos(layout, 'a')
    const b = pos(layout, 'b')
    const c = pos(layout, 'c')
    // Children are ordered left→right and sit one level below the root.
    expect(a.x).toBeLessThan(b.x)
    expect(b.x).toBeLessThan(c.x)
    expect(a.y).toBe(root.y + 120)
    // The root is centered over its children.
    expect(root.x).toBeCloseTo((a.x + c.x) / 2, 5)
  })

  it('places a nested sub-agent under its spawner, not the root', () => {
    const m = map(
      [node('root', 'main'), node('a'), node('a1')],
      [
        { from: 'root', to: 'a', spawnedAt: 0 },
        { from: 'a', to: 'a1', spawnedAt: 0 }
      ]
    )
    const layout = layoutAgentMap(m, 800)
    const a = pos(layout, 'a')
    const a1 = pos(layout, 'a1')
    expect(a1.x).toBeCloseTo(a.x, 5)
    expect(a1.y).toBe(a.y + 120)
  })

  it('keeps every node inside the canvas even with many leaves', () => {
    const ids = ['root', 'a', 'b', 'c', 'd', 'e']
    const nodes = [node('root', 'main'), ...ids.slice(1).map((id) => node(id))]
    const edges = ids.slice(1).map((id) => ({ from: 'root', to: id, spawnedAt: 0 }))
    const layout = layoutAgentMap(map(nodes, edges), 600)
    // Node boxes (168x56 around each center) must stay inside the canvas.
    for (const position of layout.positions.values()) {
      expect(position.x - 168 / 2).toBeGreaterThanOrEqual(0)
      expect(position.x + 168 / 2).toBeLessThanOrEqual(600)
    }
  })

  it('grows a chip row for nodes with tool calls and reports rendered box heights on edges', () => {
    const withTools = node('root', 'main')
    withTools.toolCalls = [
      { callId: '1', name: 'Bash', summary: '', state: 'completed', startTs: 0 }
    ]
    const layout = layoutAgentMap(
      map([withTools, node('a')], [{ from: 'root', to: 'a', spawnedAt: 0 }]),
      800
    )
    const edge = layout.edges[0]
    expect(edge?.fromHeight).toBe(56 + 20)
    expect(edge?.toHeight).toBe(56)
    // The canvas grows with the tallest box, not the bare node height.
    expect(layout.height).toBe(48 * 2 + 76 + 120)
    const bare = layoutAgentMap(map([node('root', 'main')], []), 800)
    expect(bare.height).toBe(48 * 2 + 56)
  })

  it('still places a node whose parent cycle the root walk misses', () => {
    const m = map(
      [node('root', 'main'), node('a'), node('b')],
      [
        { from: 'a', to: 'b', spawnedAt: 0 },
        { from: 'b', to: 'a', spawnedAt: 0 }
      ]
    )
    const layout = layoutAgentMap(m, 800)
    expect(layout.positions.has('a')).toBe(true)
    expect(layout.positions.has('b')).toBe(true)
    expect(layout.positions.has('root')).toBe(true)
  })
})
