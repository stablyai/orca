// Pure presentation logic for Orca Cloud workspace surfaces (sidebar dot, status panel, overlays).
import { getIntlLocale, translate } from '@/i18n/i18n'
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

/** A wake event older than this without a terminal event is treated as stale (the step timed out). */
export const WAKE_STALE_MS = 4 * 60_000
/** A failed wake's error card stays this long unless dismissed or retried. */
export const WAKE_FAILED_STALE_MS = 10 * 60_000

export function isWakeActive(wake: CloudWakeProgressEvent | undefined, now: number): boolean {
  return Boolean(
    wake &&
    (wake.phase === 'waking' || wake.phase === 'connecting') &&
    now - wake.at < WAKE_STALE_MS
  )
}

export function isWakeFailedFresh(wake: CloudWakeProgressEvent | undefined, now: number): boolean {
  return Boolean(wake && wake.phase === 'failed' && now - wake.at < WAKE_FAILED_STALE_MS)
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
  if (isWakeFailedFresh(wake, now) || status?.state === 'failed') {
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

/** An OOM notice shows for kills the user has not dismissed. */
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
  const number = (value: number, digits: number) =>
    new Intl.NumberFormat(getIntlLocale(), {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits
    }).format(value)
  if (gb >= 10) {
    return translate('orcaCloudWorkspace.bytes.gb', '{{value}} GB', { value: number(gb, 0) })
  }
  if (gb >= 1) {
    return translate('orcaCloudWorkspace.bytes.gb', '{{value}} GB', { value: number(gb, 1) })
  }
  return translate('orcaCloudWorkspace.bytes.mb', '{{value}} MB', {
    value: number(Math.max(0, bytes / 1e6), 0)
  })
}

/** "45s", "12m", "3h 05m", "2d 4h" (units translated). */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) {
    return translate('orcaCloudWorkspace.duration.seconds', '{{s}}s', { s })
  }
  const m = Math.floor(s / 60)
  if (m < 60) {
    return translate('orcaCloudWorkspace.duration.minutes', '{{m}}m', { m })
  }
  const h = Math.floor(m / 60)
  if (h < 24) {
    return translate('orcaCloudWorkspace.duration.hoursMinutes', '{{h}}h {{m}}m', {
      h,
      m: String(m % 60).padStart(2, '0')
    })
  }
  return translate('orcaCloudWorkspace.duration.daysHours', '{{d}}d {{h}}h', {
    d: Math.floor(h / 24),
    h: h % 24
  })
}

/** Hours used with one decimal under 100 h ("0.4 h", "12.5 h", "140 h"). */
export function formatHours(ms: number): string {
  const h = ms / 3_600_000
  const digits = h >= 100 ? 0 : 1
  const value = new Intl.NumberFormat(getIntlLocale(), {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  }).format(h)
  return translate('orcaCloudWorkspace.duration.hours', '{{value}} h', { value })
}

export function formatCents(cents: number): string {
  return new Intl.NumberFormat(getIntlLocale(), { style: 'currency', currency: 'USD' }).format(
    Math.max(0, cents) / 100
  )
}

/** "5 minutes ago", "yesterday" in the UI language. */
export function formatRelative(at: number, now: number): string {
  const seconds = Math.round((at - now) / 1000)
  const rtf = new Intl.RelativeTimeFormat(getIntlLocale(), { numeric: 'auto' })
  const abs = Math.abs(seconds)
  if (abs < 60) {
    return rtf.format(seconds, 'second')
  }
  if (abs < 3600) {
    return rtf.format(Math.round(seconds / 60), 'minute')
  }
  if (abs < 86_400) {
    return rtf.format(Math.round(seconds / 3600), 'hour')
  }
  return rtf.format(Math.round(seconds / 86_400), 'day')
}

/** "Dec 8" in the UI language. */
export function formatShortDate(at: number): string {
  return new Intl.DateTimeFormat(getIntlLocale(), { month: 'short', day: 'numeric' }).format(at)
}

export type DiffStat = { files: number; insertions: number; deletions: number }

/** Parses a `--shortstat` line ("2 files changed, 41 insertions(+), 6 deletions(-)"). */
export function parseDiffStat(line: string | null | undefined): DiffStat | null {
  if (!line) {
    return null
  }
  const files = /(\d+) files? changed/.exec(line)
  if (!files) {
    return null
  }
  const insertions = /(\d+) insertions?\(\+\)/.exec(line)
  const deletions = /(\d+) deletions?\(-\)/.exec(line)
  return {
    files: Number(files[1]),
    insertions: insertions ? Number(insertions[1]) : 0,
    deletions: deletions ? Number(deletions[1]) : 0
  }
}

export type ChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'unknown'

/** Porcelain letters ("M", "??") or the offline cache's words ("modified") to one kind. */
export function changeKind(status: string): ChangeKind {
  const value = status.trim()
  switch (value) {
    case 'M':
    case 'modified':
      return 'modified'
    case 'A':
    case 'added':
      return 'added'
    case 'D':
    case 'deleted':
      return 'deleted'
    case 'R':
    case 'renamed':
      return 'renamed'
    case 'C':
    case 'copied':
      return 'copied'
    case '??':
    case 'U':
    case 'untracked':
      return 'untracked'
    default:
      return /^[MADRC]/.test(value) ? changeKind(value[0]!) : 'unknown'
  }
}

export const CHANGE_LETTER: Record<ChangeKind, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
  unknown: '?'
}

/** "Ns ago" hides under a minute, where it would read as noise. */
export function showUpdatedAgo(fetchedAt: number | null, now: number): boolean {
  return fetchedAt !== null && now - fetchedAt >= 60_000
}

/** "14.6 sandbox hours" (one product noun, per the glossary). */
export function formatSandboxHours(ms: number): string {
  const h = ms / 3_600_000
  const digits = h >= 100 ? 0 : 1
  const value = new Intl.NumberFormat(getIntlLocale(), {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  }).format(h)
  return translate('orcaCloudWorkspace.sandboxHoursValue', '{{value}} sandbox hours', { value })
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
