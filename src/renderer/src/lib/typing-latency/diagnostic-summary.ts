/**
 * Pure summarization for the devtools typing-latency probe: percentiles over
 * per-keystroke samples, plus the scale census (agent rows, tabs, panes,
 * worktree nesting, suspect settings) that explains WHY a renderer is slow.
 *
 * Kept separate from the DOM/store wiring in diagnostic.ts so
 * the arithmetic is unit-testable without an xterm or a live store.
 */
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { getRendererAppPlatform } from '../renderer-app-platform'

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

export function typingSampleDurationMs(
  startedAt: number | null,
  stoppedAt: number | null,
  now: number
): number | null {
  return startedAt === null ? null : Math.max(0, Math.round((stoppedAt ?? now) - startedAt))
}

export type WorktreeNestingCensus = {
  maxDepth: number
  nestedWorktrees: number
}

type WorktreeLike = { path?: string | null; hostId?: string | null }

/**
 * Case-only path twins are one directory on a case-insensitive filesystem, so the
 * census must fold them or the nesting they form goes uncounted. Windows drive/UNC
 * keys are already folded by `normalizeRuntimePathForComparison`; a POSIX key folds
 * only for the local host, where the client platform really does report the
 * filesystem (default macOS APFS is case-insensitive). Remote POSIX paths stay
 * byte-exact — the execution host owns that fact and we cannot see it from here.
 */
function worktreeNestingKey(rawPath: string, foldPosixCase: boolean): string {
  const normalized = normalizeRuntimePathForComparison(rawPath)
  return foldPosixCase && !isWindowsAbsolutePathLike(rawPath.normalize('NFC'))
    ? normalized.toLowerCase()
    : normalized
}

export function summarizeWorktreeNesting(
  worktrees: readonly WorktreeLike[],
  localPlatform: NodeJS.Platform = getRendererAppPlatform()
): WorktreeNestingCensus {
  const pathsByHost = new Map<string, Set<string>>()
  for (const worktree of worktrees) {
    if (typeof worktree.path !== 'string' || worktree.path.length === 0) {
      continue
    }
    // An absent hostId means the local host, so it must not partition away from 'local'.
    const hostId = worktree.hostId ?? LOCAL_EXECUTION_HOST_ID
    const paths = pathsByHost.get(hostId) ?? new Set<string>()
    paths.add(
      worktreeNestingKey(
        worktree.path,
        hostId === LOCAL_EXECUTION_HOST_ID && localPlatform === 'darwin'
      )
    )
    pathsByHost.set(hostId, paths)
  }
  let maxDepth = 0
  let nestedWorktrees = 0
  for (const paths of pathsByHost.values()) {
    for (const candidate of paths) {
      let depth = 0
      for (const ancestor of paths) {
        const ancestorPrefix = ancestor.endsWith('/') ? ancestor : `${ancestor}/`
        if (ancestor !== candidate && candidate.startsWith(ancestorPrefix)) {
          depth += 1
        }
      }
      maxDepth = Math.max(maxDepth, depth)
      if (depth > 0) {
        nestedWorktrees += 1
      }
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

function collectWorktrees(
  byRepo: Record<string, WorktreeLike[]> | null | undefined
): WorktreeLike[] {
  if (!byRepo) {
    return []
  }
  const collected: WorktreeLike[] = []
  for (const worktrees of Object.values(byRepo)) {
    if (!Array.isArray(worktrees)) {
      continue
    }
    for (const worktree of worktrees) {
      if (typeof worktree?.path === 'string') {
        collected.push(worktree)
      }
    }
  }
  return collected
}

export function summarizeTypingScaleCensus(input: {
  state: TypingCensusStoreShape | null
  appVersion: string | null
  livePaneCount: number | null
  instrumentedPaneCount: number
  mountedAgentRowCount: number | null
  storeListenerCount: number | null
  focusedPane: FocusedPaneCensus | null
  localPlatform?: NodeJS.Platform
}): TypingScaleCensus {
  const state = input.state
  const settings = state?.settings ?? null
  const worktrees = collectWorktrees(state?.worktreesByRepo)
  const storeLive = countRecord(state?.agentStatusByPaneKey)
  const storeRetained = countRecord(state?.retainedAgentsByPaneKey)
  return {
    appVersion: input.appVersion,
    repos: state?.worktreesByRepo ? Object.keys(state.worktreesByRepo).length : 0,
    worktrees: worktrees.length,
    worktreeNesting: summarizeWorktreeNesting(worktrees, input.localPlatform),
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
