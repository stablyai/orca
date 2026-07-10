export type RendererPerfWorktreeKind = 'local' | 'ssh' | 'runtime' | 'floating' | 'other'

export type RendererPerfPaneMetrics = {
  readonly cols: number
  readonly rows: number
  readonly normalBufferRows: number
  readonly altBufferRows: number
  readonly hasWebgl: boolean
}

export type RendererPerfWorktreeMetrics = {
  readonly worktreeLabel: string
  readonly worktreeKind: RendererPerfWorktreeKind
  readonly paneCount: number
  readonly scrollbackRowsTotal: number
  readonly panes: readonly RendererPerfPaneMetrics[]
}

export type RendererPerfBrowserPaneMetrics = {
  readonly browserWebviewCount: number
  readonly registeredBrowserGuestCount: number
}

export type RendererPerfRegistryMetrics = {
  readonly ptySerializerCount: number
  readonly livePaneManagerCount: number
  readonly browserWebviewCount: number
  readonly registeredBrowserGuestCount: number
}

export type RendererPerfV8HeapStatistics = {
  readonly totalHeapSizeBytes?: number
  readonly totalHeapSizeExecutableBytes?: number
  readonly totalPhysicalSizeBytes?: number
  readonly totalAvailableSizeBytes?: number
  readonly usedHeapSizeBytes?: number
  readonly heapSizeLimitBytes?: number
  readonly mallocedMemoryBytes?: number
  readonly peakMallocedMemoryBytes?: number
  readonly externalMemoryBytes?: number
}

export type RendererPerfMetrics = {
  readonly domNodeCount?: number
  readonly jsHeapUsedBytes?: number
  readonly jsHeapTotalBytes?: number
  readonly jsHeapLimitBytes?: number
  readonly v8HeapStatistics?: RendererPerfV8HeapStatistics
  readonly terminalPanes: {
    readonly totalMountedPaneCount: number
    readonly worktrees: readonly RendererPerfWorktreeMetrics[]
  }
  readonly browserPanes: RendererPerfBrowserPaneMetrics
  readonly registries: RendererPerfRegistryMetrics
  readonly truncated?: boolean
}

export type RendererPerfDomCounters = {
  readonly documents: number
  readonly nodes: number
  readonly jsEventListeners: number
}

export type RendererPerfProcessMemory = Record<string, number>

export type RendererPerfUnavailableReason =
  | 'no-renderer'
  | 'renderer-destroyed'
  | 'send-failed'
  | 'timeout'
  | 'invalid-response'
  | 'collection-disabled'
  | 'record-too-large'

export type RendererPerfRecord = {
  readonly type: 'renderer-perf'
  readonly schema_version: 1
  readonly collected_at: string
  readonly renderer?: RendererPerfMetrics
  readonly main?: {
    readonly domCounters?: RendererPerfDomCounters
    readonly processMemoryBytes?: RendererPerfProcessMemory
  }
  readonly unavailableReason?: RendererPerfUnavailableReason
  readonly unavailable?: Record<string, string>
  readonly truncated?: boolean
}

export const MAX_WORKTREES = 200
export const MAX_PANES_PER_WORKTREE = 100
const MAX_LABEL_LENGTH = 80
// Why: fields carry byte values, and a leaky renderer heap past 1 GB is the
// exact signal diagnostics must not clip — bound at 1 PB, not 1e9.
const MAX_SAFE_COUNT = 1_000_000_000_000_000
const WORKTREE_KINDS = new Set<RendererPerfWorktreeKind>([
  'local',
  'ssh',
  'runtime',
  'floating',
  'other'
])

export function narrowRendererPerfMetrics(value: unknown): RendererPerfMetrics | null {
  if (!isRecord(value)) {
    return null
  }

  let truncated = value.truncated === true
  const browserPanes = narrowBrowserPanes(value.browserPanes)
  const registries = narrowRegistries(value.registries, browserPanes)
  const terminalPanes = narrowTerminalPanes(value.terminalPanes)
  truncated = truncated || terminalPanes.truncated

  const metrics: RendererPerfMetrics = {
    terminalPanes: terminalPanes.value,
    browserPanes,
    registries,
    ...(optionalCount(value.domNodeCount) !== undefined
      ? { domNodeCount: optionalCount(value.domNodeCount) }
      : {}),
    ...(optionalCount(value.jsHeapUsedBytes) !== undefined
      ? { jsHeapUsedBytes: optionalCount(value.jsHeapUsedBytes) }
      : {}),
    ...(optionalCount(value.jsHeapTotalBytes) !== undefined
      ? { jsHeapTotalBytes: optionalCount(value.jsHeapTotalBytes) }
      : {}),
    ...(optionalCount(value.jsHeapLimitBytes) !== undefined
      ? { jsHeapLimitBytes: optionalCount(value.jsHeapLimitBytes) }
      : {}),
    ...(narrowV8HeapStatistics(value.v8HeapStatistics)
      ? { v8HeapStatistics: narrowV8HeapStatistics(value.v8HeapStatistics) }
      : {}),
    ...(truncated ? { truncated: true } : {})
  }

  return metrics
}

export function clampRendererPerfCount(value: unknown): number {
  return clampNonNegativeNumber(value, 0)
}

function narrowTerminalPanes(value: unknown): {
  value: RendererPerfMetrics['terminalPanes']
  truncated: boolean
} {
  if (!isRecord(value)) {
    return { value: { totalMountedPaneCount: 0, worktrees: [] }, truncated: false }
  }

  const rawWorktrees = Array.isArray(value.worktrees) ? value.worktrees : []
  const narrowedWorktrees = rawWorktrees.slice(0, MAX_WORKTREES).map(narrowWorktree)
  const worktrees = narrowedWorktrees.map(([worktree]) => worktree)
  return {
    value: {
      totalMountedPaneCount: clampRendererPerfCount(value.totalMountedPaneCount),
      worktrees
    },
    truncated:
      rawWorktrees.length > worktrees.length ||
      narrowedWorktrees.some(([, wasTruncated]) => wasTruncated)
  }
}

function narrowWorktree(value: unknown): [RendererPerfWorktreeMetrics, boolean] {
  if (!isRecord(value)) {
    return [
      {
        worktreeLabel: 'worktree',
        worktreeKind: 'other',
        paneCount: 0,
        scrollbackRowsTotal: 0,
        panes: []
      },
      false
    ]
  }

  const rawPanes = Array.isArray(value.panes) ? value.panes : []
  const panes = rawPanes.slice(0, MAX_PANES_PER_WORKTREE).map(narrowPane)
  const label = stringField(value.worktreeLabel, MAX_LABEL_LENGTH) ?? 'worktree'
  const worktreeKind = WORKTREE_KINDS.has(value.worktreeKind as RendererPerfWorktreeKind)
    ? (value.worktreeKind as RendererPerfWorktreeKind)
    : 'other'

  return [
    {
      worktreeLabel: label,
      worktreeKind,
      paneCount: clampRendererPerfCount(value.paneCount),
      scrollbackRowsTotal: clampRendererPerfCount(value.scrollbackRowsTotal),
      panes
    },
    // Compare against the trimmed input so whitespace padding does not
    // count as truncation — `truncated` must mean data was dropped.
    rawPanes.length > panes.length ||
      (typeof value.worktreeLabel === 'string' && label.length < value.worktreeLabel.trim().length)
  ]
}

function narrowPane(value: unknown): RendererPerfPaneMetrics {
  if (!isRecord(value)) {
    return {
      cols: 0,
      rows: 0,
      normalBufferRows: 0,
      altBufferRows: 0,
      hasWebgl: false
    }
  }
  return {
    cols: clampRendererPerfCount(value.cols),
    rows: clampRendererPerfCount(value.rows),
    normalBufferRows: clampRendererPerfCount(value.normalBufferRows),
    altBufferRows: clampRendererPerfCount(value.altBufferRows),
    hasWebgl: value.hasWebgl === true
  }
}

function narrowBrowserPanes(value: unknown): RendererPerfBrowserPaneMetrics {
  if (!isRecord(value)) {
    return { browserWebviewCount: 0, registeredBrowserGuestCount: 0 }
  }
  return {
    browserWebviewCount: clampRendererPerfCount(value.browserWebviewCount),
    registeredBrowserGuestCount: clampRendererPerfCount(value.registeredBrowserGuestCount)
  }
}

function narrowRegistries(
  value: unknown,
  browserPanes: RendererPerfBrowserPaneMetrics
): RendererPerfRegistryMetrics {
  if (!isRecord(value)) {
    return {
      ptySerializerCount: 0,
      livePaneManagerCount: 0,
      browserWebviewCount: browserPanes.browserWebviewCount,
      registeredBrowserGuestCount: browserPanes.registeredBrowserGuestCount
    }
  }
  return {
    ptySerializerCount: clampRendererPerfCount(value.ptySerializerCount),
    livePaneManagerCount: clampRendererPerfCount(value.livePaneManagerCount),
    browserWebviewCount: clampRendererPerfCount(value.browserWebviewCount),
    registeredBrowserGuestCount: clampRendererPerfCount(value.registeredBrowserGuestCount)
  }
}

function narrowV8HeapStatistics(value: unknown): RendererPerfV8HeapStatistics | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const stats: RendererPerfV8HeapStatistics = {}
  copyOptionalCount(value, stats, 'totalHeapSizeBytes')
  copyOptionalCount(value, stats, 'totalHeapSizeExecutableBytes')
  copyOptionalCount(value, stats, 'totalPhysicalSizeBytes')
  copyOptionalCount(value, stats, 'totalAvailableSizeBytes')
  copyOptionalCount(value, stats, 'usedHeapSizeBytes')
  copyOptionalCount(value, stats, 'heapSizeLimitBytes')
  copyOptionalCount(value, stats, 'mallocedMemoryBytes')
  copyOptionalCount(value, stats, 'peakMallocedMemoryBytes')
  copyOptionalCount(value, stats, 'externalMemoryBytes')
  return Object.keys(stats).length > 0 ? stats : undefined
}

function copyOptionalCount(
  source: Record<string, unknown>,
  target: Record<string, number>,
  key: string
): void {
  const value = optionalCount(source[key])
  if (value !== undefined) {
    target[key] = value
  }
}

function optionalCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return clampNonNegativeNumber(value, 0)
}

function clampNonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(MAX_SAFE_COUNT, Math.max(0, Math.floor(value)))
}

function stringField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
