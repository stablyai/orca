/**
 * Parse optional structured board ops from an agent reply.
 *
 * Agents cannot freehand yet. They can emit a fenced JSON block the board
 * applies as geo / note / agent-draft shapes:
 *
 * ```collab-board
 * [
 *   { "op": "draft", "body": "…" },
 *   { "op": "geo", "geo": "rectangle", "x": 40, "y": 40, "w": 200, "h": 100, "label": "Login" },
 *   { "op": "note", "x": 40, "y": 160, "text": "Validate email" }
 * ]
 * ```
 *
 * Unknown ops are ignored. Pure parse — apply is separate (editor-facing).
 */

export type CollabBoardOp =
  | {
      op: 'draft'
      body: string
      x?: number
      y?: number
      w?: number
      h?: number
    }
  | {
      op: 'geo'
      geo: 'rectangle' | 'ellipse' | 'triangle' | 'diamond' | 'cloud' | 'hexagon' | 'oval' | 'star'
      x: number
      y: number
      w: number
      h: number
      label?: string
    }
  | {
      op: 'note'
      x: number
      y: number
      text: string
    }

const FENCE_RE =
  /```(?:collab-board|collab-shapes|agent-board)\s*\n([\s\S]*?)```/i

const GEO_OK = new Set([
  'rectangle',
  'ellipse',
  'triangle',
  'diamond',
  'cloud',
  'hexagon',
  'oval',
  'star'
])

function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function normalizeOp(raw: unknown): CollabBoardOp | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const op = String(o.op ?? o.type ?? '').toLowerCase()

  if (op === 'draft' || op === 'agent-draft') {
    const body = String(o.body ?? o.text ?? '').trim()
    if (!body) return null
    return {
      op: 'draft',
      body,
      x: typeof o.x === 'number' ? o.x : undefined,
      y: typeof o.y === 'number' ? o.y : undefined,
      w: typeof o.w === 'number' ? o.w : undefined,
      h: typeof o.h === 'number' ? o.h : undefined
    }
  }

  if (op === 'geo' || op === 'shape') {
    const geo = String(o.geo ?? o.shape ?? 'rectangle').toLowerCase()
    if (!GEO_OK.has(geo)) return null
    const w = asNumber(o.w, 160)
    const h = asNumber(o.h, 100)
    if (w <= 0 || h <= 0) return null
    return {
      op: 'geo',
      geo: geo as Extract<CollabBoardOp, { op: 'geo' }>['geo'],
      x: asNumber(o.x, 40),
      y: asNumber(o.y, 40),
      w,
      h,
      label: typeof o.label === 'string' ? o.label : typeof o.text === 'string' ? o.text : undefined
    }
  }

  if (op === 'note' || op === 'text') {
    const text = String(o.text ?? o.body ?? '').trim()
    if (!text) return null
    return {
      op: 'note',
      x: asNumber(o.x, 40),
      y: asNumber(o.y, 40),
      text
    }
  }

  return null
}

export type ParseAgentBoardOpsResult = {
  ops: CollabBoardOp[]
  /** Reply with the collab-board fence removed (for draft body fallback). */
  proseWithoutFence: string
}

export function parseAgentBoardOps(reply: string): ParseAgentBoardOpsResult {
  const match = FENCE_RE.exec(reply)
  if (!match) {
    return { ops: [], proseWithoutFence: reply.trim() }
  }
  const jsonText = match[1].trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return { ops: [], proseWithoutFence: reply.replace(FENCE_RE, '').trim() }
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  const ops: CollabBoardOp[] = []
  for (const item of list) {
    const op = normalizeOp(item)
    if (op) ops.push(op)
  }
  return {
    ops,
    proseWithoutFence: reply.replace(FENCE_RE, '').trim()
  }
}
