import { getBrowserWebviewMemoryProfile } from '@/components/browser-pane/webview-registry'
import { getRegisteredPtySerializerCount } from '@/components/terminal-pane/pty-buffer-serializer'
import { getLivePaneManagerCount } from '@/lib/pane-manager/pane-manager-registry'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { listRegisteredTerminalTabPerfSources } from '@/runtime/sync-runtime-graph'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { getWorktreePathBasenameFromId } from '../../../shared/worktree-id'
import {
  MAX_PANES_PER_WORKTREE,
  MAX_WORKTREES,
  type RendererPerfBrowserPaneMetrics,
  type RendererPerfMetrics,
  type RendererPerfPaneMetrics,
  type RendererPerfWorktreeKind
} from '../../../shared/renderer-perf-metrics'

export type RendererPerfTabSource = {
  readonly worktreeId: string
  readonly getManager: () => PaneManager | null
}

type BrowserPerformanceMemory = {
  readonly usedJSHeapSize?: number
  readonly totalJSHeapSize?: number
  readonly jsHeapSizeLimit?: number
}

type RendererPerfSnapshotOptions = {
  readonly listTabSources?: () => readonly RendererPerfTabSource[]
  readonly getAppState?: () => AppState
  readonly getBrowserProfile?: () => RendererPerfBrowserPaneMetrics
  readonly getPtySerializerCount?: () => number
  readonly getLiveManagerCount?: () => number
}

let disposePerfMetricsRequestListener: (() => void) | null = null

export function collectRendererPerfSnapshot(
  opts: RendererPerfSnapshotOptions = {}
): RendererPerfMetrics {
  const browserPanes = opts.getBrowserProfile?.() ?? getBrowserWebviewMemoryProfile()
  const terminalPanes = collectTerminalPaneMetrics({
    sources: opts.listTabSources?.() ?? listRegisteredTerminalTabPerfSources(),
    getAppState: opts.getAppState ?? useAppStore.getState
  })
  const memory = getPerformanceMemory()

  return {
    domNodeCount: getDomNodeCount(),
    ...(memory?.usedJSHeapSize !== undefined ? { jsHeapUsedBytes: memory.usedJSHeapSize } : {}),
    ...(memory?.totalJSHeapSize !== undefined ? { jsHeapTotalBytes: memory.totalJSHeapSize } : {}),
    ...(memory?.jsHeapSizeLimit !== undefined ? { jsHeapLimitBytes: memory.jsHeapSizeLimit } : {}),
    terminalPanes,
    browserPanes,
    registries: {
      ptySerializerCount: opts.getPtySerializerCount?.() ?? getRegisteredPtySerializerCount(),
      livePaneManagerCount: opts.getLiveManagerCount?.() ?? getLivePaneManagerCount(),
      browserWebviewCount: browserPanes.browserWebviewCount,
      registeredBrowserGuestCount: browserPanes.registeredBrowserGuestCount
    }
  }
}

export function installRendererPerfSnapshotDiagnostics(): void {
  if (disposePerfMetricsRequestListener || typeof window === 'undefined') {
    return
  }
  disposePerfMetricsRequestListener = window.api.diagnostics.onPerfMetricsRequest(
    ({ requestId }) => {
      try {
        window.api.diagnostics.sendPerfMetrics(requestId, collectRendererPerfSnapshot())
      } catch {
        window.api.diagnostics.sendPerfMetrics(requestId, emptyRendererPerfSnapshot())
      }
    }
  )
}

export function _disposeRendererPerfSnapshotDiagnosticsForTests(): void {
  disposePerfMetricsRequestListener?.()
  disposePerfMetricsRequestListener = null
}

if (typeof import.meta !== 'undefined' && import.meta.hot) {
  import.meta.hot.dispose(() => {
    _disposeRendererPerfSnapshotDiagnosticsForTests()
  })
}

type MutableWorktreeMetrics = {
  worktreeLabel: string
  worktreeKind: RendererPerfWorktreeKind
  paneCount: number
  scrollbackRowsTotal: number
  panes: RendererPerfPaneMetrics[]
}

function collectTerminalPaneMetrics({
  sources,
  getAppState
}: {
  readonly sources: readonly RendererPerfTabSource[]
  readonly getAppState: () => AppState
}): RendererPerfMetrics['terminalPanes'] {
  const groups = new Map<string, MutableWorktreeMetrics>()
  const fallbackLabels = new Map<string, string>()
  const state = getAppState()
  let totalMountedPaneCount = 0

  for (const source of sources) {
    try {
      const manager = source.getManager()
      if (!manager) {
        continue
      }
      const panes = manager.getPanes()
      const renderingByPaneId = new Map(
        manager.getRenderingDiagnostics().map((diagnostic) => [diagnostic.paneId, diagnostic])
      )
      let worktree = groups.get(source.worktreeId)
      if (!worktree) {
        // Why: bound the per-worktree detail before it is allocated and
        // serialized over IPC; totals stay accurate past the cap.
        if (groups.size >= MAX_WORKTREES) {
          totalMountedPaneCount += panes.length
          continue
        }
        worktree = createWorktreeMetrics(source.worktreeId, state, fallbackLabels)
        groups.set(source.worktreeId, worktree)
      }
      for (const pane of panes) {
        const paneMetrics = collectPaneMetrics(
          pane.terminal,
          renderingByPaneId.get(pane.id)?.hasWebgl === true
        )
        totalMountedPaneCount += 1
        worktree.paneCount += 1
        worktree.scrollbackRowsTotal += paneMetrics.normalBufferRows + paneMetrics.altBufferRows
        if (worktree.panes.length < MAX_PANES_PER_WORKTREE) {
          worktree.panes.push(paneMetrics)
        }
      }
    } catch {
      // Why: terminal panes can unmount while diagnostics are reading them.
    }
  }

  return {
    totalMountedPaneCount,
    worktrees: [...groups.values()]
  }
}

function collectPaneMetrics(
  terminal: {
    readonly cols?: number
    readonly rows?: number
    readonly buffer?: {
      readonly normal?: { readonly length?: number }
      readonly alternate?: { readonly length?: number }
    }
  },
  hasWebgl: boolean
): RendererPerfPaneMetrics {
  return {
    cols: nonNegativeCount(terminal.cols),
    rows: nonNegativeCount(terminal.rows),
    normalBufferRows: nonNegativeCount(terminal.buffer?.normal?.length),
    altBufferRows: nonNegativeCount(terminal.buffer?.alternate?.length),
    hasWebgl
  }
}

function createWorktreeMetrics(
  worktreeId: string,
  state: AppState,
  fallbackLabels: Map<string, string>
): MutableWorktreeMetrics {
  return {
    worktreeLabel: resolveWorktreeLabel(worktreeId, fallbackLabels),
    worktreeKind: resolveWorktreeKind(worktreeId, state),
    paneCount: 0,
    scrollbackRowsTotal: 0,
    panes: []
  }
}

function resolveWorktreeKind(worktreeId: string, state: AppState): RendererPerfWorktreeKind {
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return 'floating'
  }
  try {
    const connectionId = getConnectionIdFromState(state, worktreeId)
    if (typeof connectionId === 'string' && connectionId.trim()) {
      return 'ssh'
    }
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
    if (typeof runtimeEnvironmentId === 'string' && runtimeEnvironmentId.trim()) {
      return 'runtime'
    }
    if (connectionId === null && runtimeEnvironmentId === null) {
      return 'local'
    }
  } catch {
    return 'other'
  }
  return 'other'
}

function resolveWorktreeLabel(worktreeId: string, fallbackLabels: Map<string, string>): string {
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return 'floating'
  }
  const basename = getWorktreePathBasenameFromId(worktreeId)
  if (basename) {
    return basename
  }
  const existing = fallbackLabels.get(worktreeId)
  if (existing) {
    return existing
  }
  const label = `worktree-${fallbackLabels.size + 1}`
  fallbackLabels.set(worktreeId, label)
  return label
}

function getDomNodeCount(): number {
  if (typeof document === 'undefined') {
    return 0
  }
  return document.getElementsByTagName('*').length
}

function getPerformanceMemory(): BrowserPerformanceMemory | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }
  return (window.performance as Performance & { memory?: BrowserPerformanceMemory }).memory
}

function emptyRendererPerfSnapshot(): RendererPerfMetrics {
  return {
    terminalPanes: { totalMountedPaneCount: 0, worktrees: [] },
    browserPanes: { browserWebviewCount: 0, registeredBrowserGuestCount: 0 },
    registries: {
      ptySerializerCount: 0,
      livePaneManagerCount: 0,
      browserWebviewCount: 0,
      registeredBrowserGuestCount: 0
    }
  }
}

function nonNegativeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}
