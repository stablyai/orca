import type { MaestroCanvasNode, MaestroCanvasSize } from './maestro-canvas-view-model'

/** What a window contains, which is what its chrome has to announce. */
export type MaestroWindowKind =
  | 'terminal'
  | 'browser'
  | 'note'
  | 'portal'
  | 'evidence'
  | 'run'
  | 'node'

export type MaestroStateTone = 'running' | 'input' | 'settled' | 'blocked' | 'pending' | 'unknown'

/** One hue per meaning, each already carrying that meaning elsewhere in Orca. */
export const MAESTRO_STATE_COLOR: Record<MaestroStateTone, string> = {
  running: 'var(--workspace-status-progress)',
  input: 'var(--agent-question)',
  settled: 'var(--status-success)',
  blocked: 'var(--destructive)',
  pending: 'var(--muted-foreground)',
  unknown: 'var(--muted-foreground)'
}

const SETTLED_STATES = new Set([
  'approved',
  'complete',
  'completed',
  'done',
  'released',
  'ready_to_release',
  'reclaimable',
  'recovered',
  'passed',
  'succeeded'
])
const RUNNING_STATES = new Set(['running', 'active', 'working', 'starting', 'in_progress'])
const BLOCKED_STATES = new Set(['blocked', 'failed', 'error', 'cancelled', 'canceled'])
const PENDING_STATES = new Set(['pending', 'queued', 'planned', 'idle', 'release_pending'])
const UNKNOWN_STATES = new Set(['outcome_unknown', 'unverifiable', 'unavailable', 'unknown'])

export function maestroStateTone(status: string | undefined): MaestroStateTone {
  const normalized = (status ?? '').toLowerCase().trim().replaceAll(' ', '_')
  if (RUNNING_STATES.has(normalized)) {
    return 'running'
  }
  if (normalized === 'input_required' || normalized === 'partial') {
    return 'input'
  }
  if (SETTLED_STATES.has(normalized) || normalized.startsWith('saved')) {
    return 'settled'
  }
  if (BLOCKED_STATES.has(normalized)) {
    return 'blocked'
  }
  if (PENDING_STATES.has(normalized) || normalized === 'retained') {
    return 'pending'
  }
  if (UNKNOWN_STATES.has(normalized)) {
    return 'unknown'
  }
  return normalized ? 'pending' : 'unknown'
}

const WINDOW_KIND_BY_PROJECTION: Record<string, MaestroWindowKind> = {
  'run-progress': 'run',
  portal: 'portal',
  attempt: 'terminal',
  task: 'terminal',
  'terminal-receipt': 'terminal',
  evidence: 'evidence',
  cleanup: 'evidence'
}

export function maestroWindowKind(node: MaestroCanvasNode): MaestroWindowKind {
  if (node.projectedType === 'evidence' && node.browserSurface) {
    return 'browser'
  }
  if (node.kind === 'note' && node.projectedType !== 'run-progress') {
    return 'note'
  }
  return WINDOW_KIND_BY_PROJECTION[node.projectedType ?? ''] ?? 'node'
}

const WINDOW_TYPE_LABEL: Record<MaestroWindowKind, string | null> = {
  terminal: 'Terminal',
  browser: 'Browser',
  note: 'Note',
  portal: 'Portal',
  run: 'Run',
  evidence: null,
  node: null
}

/** The short word in the chrome strip. Never the node's own title repeated. */
export function maestroWindowTypeLabel(node: MaestroCanvasNode): string {
  return (
    WINDOW_TYPE_LABEL[maestroWindowKind(node)] ?? node.projectedType?.replaceAll('-', ' ') ?? 'Node'
  )
}

type WindowMetrics = { default: MaestroCanvasSize; min: MaestroCanvasSize }

const WINDOW_METRICS: Record<MaestroWindowKind, WindowMetrics> = {
  terminal: { default: { width: 288, height: 146 }, min: { width: 208, height: 112 } },
  browser: { default: { width: 300, height: 224 }, min: { width: 224, height: 156 } },
  note: { default: { width: 264, height: 140 }, min: { width: 176, height: 104 } },
  portal: { default: { width: 244, height: 128 }, min: { width: 192, height: 100 } },
  evidence: { default: { width: 244, height: 132 }, min: { width: 192, height: 100 } },
  run: { default: { width: 364, height: 432 }, min: { width: 300, height: 240 } },
  node: { default: { width: 244, height: 132 }, min: { width: 192, height: 100 } }
}

export const MAESTRO_WINDOW_MAX: MaestroCanvasSize = { width: 1200, height: 900 }

export function maestroWindowDefaultSize(node: MaestroCanvasNode): MaestroCanvasSize {
  return WINDOW_METRICS[maestroWindowKind(node)].default
}

export function maestroWindowMinSize(node: MaestroCanvasNode): MaestroCanvasSize {
  return WINDOW_METRICS[maestroWindowKind(node)].min
}

export function clampMaestroWindowSize(
  node: MaestroCanvasNode,
  size: MaestroCanvasSize
): MaestroCanvasSize {
  const min = maestroWindowMinSize(node)
  return {
    width: Math.round(Math.min(MAESTRO_WINDOW_MAX.width, Math.max(min.width, size.width))),
    height: Math.round(Math.min(MAESTRO_WINDOW_MAX.height, Math.max(min.height, size.height)))
  }
}
