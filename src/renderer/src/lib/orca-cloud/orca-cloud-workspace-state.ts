// Pure presentation logic for Orca Cloud workspace surfaces (sidebar dot, status panel, overlays).
import type {
  CloudOomEvent,
  CloudWakeProgressEvent
} from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import type { HostedWorkspaceStatus } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'

/** What the sidebar dot shows; one vocabulary across dot, hover card and overlays. */
export type CloudDotState =
  | 'running'
  | 'sleeping'
  | 'waking'
  | 'unresponsive'
  | 'archived'
  | 'failed'
  | 'unknown'

/** A wake event older than this without a terminal phase is treated as stale (the step timed out). */
const WAKE_STALE_MS = 4 * 60_000

export function isWakeActive(wake: CloudWakeProgressEvent | undefined, now: number): boolean {
  return Boolean(
    wake && (wake.phase === 'waking' || wake.phase === 'connecting') && now - wake.at < WAKE_STALE_MS
  )
}

/**
 * Priority: an in-flight wake beats everything (the user just asked for it), then the
 * control plane's state; the desktop's own sleep record only before the first status read.
 */
export function deriveCloudDotState(input: {
  status: HostedWorkspaceStatus | null
  wake: CloudWakeProgressEvent | undefined
  sleeping: boolean
  now: number
}): CloudDotState {
  const { status, wake, sleeping, now } = input
  if (isWakeActive(wake, now)) {
    return 'waking'
  }
  if (status?.state === 'archived' || status?.archive) {
    return 'archived'
  }
  if (wake?.phase === 'failed' && now - wake.at < WAKE_STALE_MS) {
    return 'failed'
  }
  if (status?.state === 'failed') {
    return 'failed'
  }
  // The control plane is the truth for the VM; the desktop's own sleep record only fills in
  // before the first status read (a cloud workspace with no open panes is not asleep).
  if (!status) {
    return sleeping ? 'sleeping' : 'unknown'
  }
  switch (status.state) {
    case 'ready':
      return 'running'
    case 'unresponsive':
      return 'unresponsive'
    case 'sleeping':
    case 'stopping':
      return 'sleeping'
    case 'waking':
    case 'provisioning':
      return 'waking'
    default:
      return 'unknown'
  }
}

/** An OOM banner shows for kills the user has not dismissed. */
export function visibleOom(
  oom: CloudOomEvent | undefined,
  dismissedKills: number | undefined
): CloudOomEvent | null {
  if (!oom) {
    return null
  }
  return dismissedKills !== undefined && oom.oomKills <= dismissedKills ? null : oom
}

export function formatBytes(bytes: number): string {
  const gb = bytes / 1e9
  if (gb >= 10) {
    return `${Math.round(gb)} GB`
  }
  if (gb >= 1) {
    return `${gb.toFixed(1)} GB`
  }
  return `${Math.max(0, Math.round(bytes / 1e6))} MB`
}

/** "45s", "12m", "3h 05m", "2d 4h". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) {
    return `${s}s`
  }
  const m = Math.floor(s / 60)
  if (m < 60) {
    return `${m}m`
  }
  const h = Math.floor(m / 60)
  if (h < 24) {
    return `${h}h ${String(m % 60).padStart(2, '0')}m`
  }
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** Hours used with one decimal under 100 h ("0.4 h", "12.5 h", "140 h"). */
export function formatHours(ms: number): string {
  const h = ms / 3_600_000
  return h >= 100 ? `${Math.round(h)} h` : `${h.toFixed(1)} h`
}

export function formatCents(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`
}

export function percentOf(used: number, total: number): number {
  return total > 0 ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : 0
}

/** Elapsed whole seconds for the waking overlay's counter. */
export function wakeElapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000))
}

export type FileTreeNode = {
  name: string
  path: string
  children: FileTreeNode[]
}

/** Builds a sorted directory tree (directories first) from a flat path list. */
export function buildFileTree(files: readonly string[]): FileTreeNode[] {
  const root: FileTreeNode = { name: '', path: '', children: [] }
  const index = new Map<string, FileTreeNode>([['', root]])
  for (const file of files) {
    const parts = file.split('/').filter(Boolean)
    let parent = root
    let path = ''
    for (const part of parts) {
      path = path ? `${path}/${part}` : part
      let node = index.get(path)
      if (!node) {
        node = { name: part, path, children: [] }
        index.set(path, node)
        parent.children.push(node)
      }
      parent = node
    }
  }
  const sort = (nodes: FileTreeNode[]): FileTreeNode[] => {
    nodes.sort((a, b) => {
      const aDir = a.children.length > 0
      const bDir = b.children.length > 0
      return aDir === bDir ? a.name.localeCompare(b.name) : aDir ? -1 : 1
    })
    for (const node of nodes) {
      sort(node.children)
    }
    return nodes
  }
  return sort(root.children)
}
