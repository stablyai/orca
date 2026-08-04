/**
 * Pure summarization for the devtools typing-latency probe: percentiles over
 * per-keystroke samples, plus the scale census (agent rows, tabs, panes,
 * worktree nesting, suspect settings) that explains WHY a renderer is slow.
 *
 * Kept separate from the DOM/store wiring in typing-latency-diagnostic.ts so
 * the arithmetic is unit-testable without an xterm or a live store.
 */

export type LatencyPercentiles = {
  count: number
  p50: number | null
  p95: number | null
  max: number | null
}

/** Nearest-rank percentile; a probe reports what it actually observed, not an interpolation. */
function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) {
    return null
  }
  const rank = Math.ceil(fraction * sorted.length)
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[index] ?? null
}

function round(value: number | null): number | null {
  return value == null ? null : Math.round(value * 100) / 100
}

export function summarizeLatencySamples(values: readonly number[]): LatencyPercentiles {
  const finite = values.filter((value) => Number.isFinite(value))
  const sorted = [...finite].sort((a, b) => a - b)
  return {
    count: sorted.length,
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted.at(-1) ?? null)
  }
}

export type WorktreeNestingCensus = {
  maxDepth: number
  nestedWorktrees: number
}

/** Windows and default macOS filesystems are case-insensitive, so compare case-folded. */
function normalizePathForNesting(rawPath: string): string {
  const unified = rawPath.replaceAll('\\', '/').toLowerCase()
  return unified.length > 1 && unified.endsWith('/') ? unified.slice(0, -1) : unified
}

export function summarizeWorktreeNesting(paths: readonly string[]): WorktreeNestingCensus {
  const normalized = paths
    .filter((path) => typeof path === 'string' && path.length > 0)
    .map((path) => normalizePathForNesting(path))
  const unique = [...new Set(normalized)]
  let maxDepth = 0
  let nestedWorktrees = 0
  for (const candidate of unique) {
    let depth = 0
    for (const ancestor of unique) {
      if (ancestor !== candidate && candidate.startsWith(`${ancestor}/`)) {
        depth += 1
      }
    }
    maxDepth = Math.max(maxDepth, depth)
    if (depth > 0) {
      nestedWorktrees += 1
    }
  }
  return { maxDepth, nestedWorktrees }
}

export type FocusedPaneCensus = {
  paneId: number | null
  leafId: string | null
  /** 'alternate' means a full-screen TUI (grok, Codex); 'normal' is a plain shell. */
  bufferType: 'normal' | 'alternate' | null
  cols: number | null
  rows: number | null
  bufferLines: number | null
  /** Agent identity from the pane's foreground process table, when Orca resolved one. */
  foregroundAgent: string | null
  /** Agent identity from the hook-reported status row for the same pane. */
  statusAgentType: string | null
}

type CountableRecord = Record<string, unknown> | null | undefined

type WorktreeLike = { path?: string | null }

export type TypingCensusStoreShape = {
  worktreesByRepo?: Record<string, WorktreeLike[]> | null
  tabsByWorktree?: Record<string, unknown[]> | null
  unifiedTabsByWorktree?: Record<string, unknown[]> | null
  agentStatusByPaneKey?: CountableRecord
  retainedAgentsByPaneKey?: CountableRecord
  activeTabId?: string | null
  activeTabType?: string | null
  settings?: Record<string, unknown> | null
}

export type TypingSettingsCensus = {
  /** Question 1 from the field report: is auto tab-title generation on? */
  tabAutoGenerateTitle: boolean | null
  compactWorktreeCards: boolean | null
  agentActivityDisplayMode: string | null
  terminalScrollbackRows: number | null
  terminalGpuAcceleration: string | null
}

export type TypingScaleCensus = {
  appVersion: string | null
  repos: number
  worktrees: number
  worktreeNesting: WorktreeNestingCensus
  tabs: { terminal: number; unified: number }
  panes: { live: number | null; instrumented: number }
  agentRows: {
    storeLive: number
    storeRetained: number
    storeTotal: number
    /** Mounted rows only; compact mode collapses most agents behind CompactAgentExpansion. */
    mountedDom: number | null
  }
  storeListeners: number | null
  settings: TypingSettingsCensus
  activeTab: { id: string | null; type: string | null }
  focusedPane: FocusedPaneCensus | null
}

function countRecord(record: CountableRecord): number {
  return record ? Object.keys(record).length : 0
}

function sumArrayLengths(byKey: Record<string, unknown[]> | null | undefined): number {
  if (!byKey) {
    return 0
  }
  let total = 0
  for (const list of Object.values(byKey)) {
    total += Array.isArray(list) ? list.length : 0
  }
  return total
}

function readBoolean(
  settings: Record<string, unknown> | null | undefined,
  key: string
): boolean | null {
  const value = settings?.[key]
  return typeof value === 'boolean' ? value : null
}

function readString(
  settings: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  const value = settings?.[key]
  return typeof value === 'string' ? value : null
}

function readNumber(
  settings: Record<string, unknown> | null | undefined,
  key: string
): number | null {
  const value = settings?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function collectWorktreePaths(byRepo: Record<string, WorktreeLike[]> | null | undefined): string[] {
  if (!byRepo) {
    return []
  }
  const paths: string[] = []
  for (const worktrees of Object.values(byRepo)) {
    if (!Array.isArray(worktrees)) {
      continue
    }
    for (const worktree of worktrees) {
      if (typeof worktree?.path === 'string') {
        paths.push(worktree.path)
      }
    }
  }
  return paths
}

export function summarizeTypingScaleCensus(input: {
  state: TypingCensusStoreShape | null
  appVersion: string | null
  livePaneCount: number | null
  instrumentedPaneCount: number
  mountedAgentRowCount: number | null
  storeListenerCount: number | null
  focusedPane: FocusedPaneCensus | null
}): TypingScaleCensus {
  const state = input.state
  const settings = state?.settings ?? null
  const worktreePaths = collectWorktreePaths(state?.worktreesByRepo)
  const storeLive = countRecord(state?.agentStatusByPaneKey)
  const storeRetained = countRecord(state?.retainedAgentsByPaneKey)
  return {
    appVersion: input.appVersion,
    repos: state?.worktreesByRepo ? Object.keys(state.worktreesByRepo).length : 0,
    worktrees: worktreePaths.length,
    worktreeNesting: summarizeWorktreeNesting(worktreePaths),
    tabs: {
      terminal: sumArrayLengths(state?.tabsByWorktree),
      unified: sumArrayLengths(state?.unifiedTabsByWorktree)
    },
    panes: { live: input.livePaneCount, instrumented: input.instrumentedPaneCount },
    agentRows: {
      storeLive,
      storeRetained,
      storeTotal: storeLive + storeRetained,
      mountedDom: input.mountedAgentRowCount
    },
    storeListeners: input.storeListenerCount,
    settings: {
      tabAutoGenerateTitle: readBoolean(settings, 'tabAutoGenerateTitle'),
      compactWorktreeCards: readBoolean(settings, 'compactWorktreeCards'),
      agentActivityDisplayMode: readString(settings, 'agentActivityDisplayMode'),
      terminalScrollbackRows: readNumber(settings, 'terminalScrollbackRows'),
      terminalGpuAcceleration: readString(settings, 'terminalGpuAcceleration')
    },
    activeTab: { id: state?.activeTabId ?? null, type: state?.activeTabType ?? null },
    focusedPane: input.focusedPane
  }
}
