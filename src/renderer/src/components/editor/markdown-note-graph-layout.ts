import type { MarkdownNoteGraph } from './markdown-note-graph'

export type GraphPoint = { x: number; y: number }

// Why a budget: the repulsion pass is O(n²), so big graphs get fewer, still-converging steps.
const PAIR_STEP_BUDGET = 4_000_000
const MAX_ITERATIONS = 300
const MIN_ITERATIONS = 60
const IDEAL_EDGE_LENGTH = 80
const REPULSION = IDEAL_EDGE_LENGTH * IDEAL_EDGE_LENGTH
const GRAVITY = 0.02

/**
 * Fruchterman–Reingold style layout: nodes repel, links pull, a weak pull keeps islands near the
 * middle. Deterministic (circle start, cooling step) so the same notes always draw the same way.
 */
export function layoutMarkdownNoteGraph(graph: MarkdownNoteGraph): Map<string, GraphPoint> {
  const keys = graph.nodes.map((node) => node.key)
  const indexOf = new Map(keys.map((key, index) => [key, index]))
  const radius = IDEAL_EDGE_LENGTH * Math.max(1, Math.sqrt(keys.length))
  const x = keys.map((_, i) => radius * Math.cos((2 * Math.PI * i) / Math.max(1, keys.length)))
  const y = keys.map((_, i) => radius * Math.sin((2 * Math.PI * i) / Math.max(1, keys.length)))
  const edges = graph.edges.flatMap((edge) => {
    const a = indexOf.get(edge.source)
    const b = indexOf.get(edge.target)
    return a === undefined || b === undefined ? [] : [[a, b] as const]
  })
  const pairs = Math.max(1, (keys.length * (keys.length - 1)) / 2)
  const iterations = Math.round(
    Math.min(MAX_ITERATIONS, Math.max(MIN_ITERATIONS, PAIR_STEP_BUDGET / pairs))
  )
  const dx = new Float64Array(keys.length)
  const dy = new Float64Array(keys.length)
  let step = radius / 4
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    dx.fill(0)
    dy.fill(0)
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        const ox = x[i] - x[j]
        const oy = y[i] - y[j]
        const distanceSquared = Math.max(ox * ox + oy * oy, 0.01)
        const force = REPULSION / distanceSquared
        dx[i] += ox * force
        dy[i] += oy * force
        dx[j] -= ox * force
        dy[j] -= oy * force
      }
    }
    for (const [a, b] of edges) {
      const ox = x[a] - x[b]
      const oy = y[a] - y[b]
      const distance = Math.max(Math.hypot(ox, oy), 0.01)
      const force = distance / IDEAL_EDGE_LENGTH
      dx[a] -= ox * force
      dy[a] -= oy * force
      dx[b] += ox * force
      dy[b] += oy * force
    }
    for (let i = 0; i < keys.length; i += 1) {
      dx[i] -= x[i] * GRAVITY
      dy[i] -= y[i] * GRAVITY
      const length = Math.hypot(dx[i], dy[i])
      if (length > 0) {
        const move = Math.min(length, step)
        x[i] += (dx[i] / length) * move
        y[i] += (dy[i] / length) * move
      }
    }
    step = Math.max(step * 0.97, 0.5)
  }
  return new Map(keys.map((key, i) => [key, { x: x[i], y: y[i] }]))
}
