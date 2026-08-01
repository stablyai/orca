import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { GlobalSettings } from '../../../../shared/types'
import {
  resolveContextPressure,
  resolveContextPressureConfigFromSettings,
  type ContextPressureConfig,
  type ContextPressureLevel,
  type ContextPressureLimitSource,
  type ContextPressureSnapshot
} from '../../../../shared/agent-context-pressure'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { selectLiveAgentStatusEntriesForWorktree } from './worktree-agent-row-selectors'

// ─── Context-pressure selection ───────────────────────────────────────────────
// Per-pane and aggregate (worktree / tab) traffic-light resolution for the
// experimental context-pressure indicator. Everything here returns null when
// the master flag is off or a session has no provider-reported usage — the UI
// renders NOTHING for unknowns, never an invented value.

type ContextPressureSettings = Pick<
  GlobalSettings,
  | 'experimentalContextPressure'
  | 'contextPressureWarnPercent'
  | 'contextPressureCriticalPercent'
  | 'contextPressureSoftLimits'
>

type ConfigCache = {
  warnPercent: number
  criticalPercent: number
  softLimits: Record<string, number> | undefined
  config: ContextPressureConfig
}

let configCache: ConfigCache | null = null

function softLimitsEqual(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b) {
    return false
  }
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) {
    return false
  }
  return aKeys.every((key) => a[key] === b[key])
}

/**
 * Resolve the pressure config from settings, or null when the experimental
 * master flag is off. Memoized on the individual fields (not the settings
 * object identity) so subscribers keep a stable reference across unrelated
 * settings writes and never re-render for them.
 */
export function getContextPressureConfig(
  settings: ContextPressureSettings | null | undefined
): ContextPressureConfig | null {
  // Shared gate+defaults resolution (also used by main's worktree.ps rows).
  const config = resolveContextPressureConfigFromSettings(settings)
  if (!config) {
    return null
  }
  if (
    configCache &&
    configCache.warnPercent === config.warnPercent &&
    configCache.criticalPercent === config.criticalPercent &&
    softLimitsEqual(configCache.softLimits, config.softLimits)
  ) {
    return configCache.config
  }
  configCache = {
    warnPercent: config.warnPercent,
    criticalPercent: config.criticalPercent,
    softLimits: config.softLimits,
    config
  }
  return config
}

/** Stable config reference for per-row indicator rendering. */
export function useContextPressureConfig(active = true): ContextPressureConfig | null {
  return useAppStore((s) => (active ? getContextPressureConfig(s.settings) : null))
}

/** Pressure snapshot for one session entry; null with no config or no data. */
export function resolveEntryContextPressure(
  entry: Pick<AgentStatusEntry, 'contextUsage' | 'model' | 'agentType'>,
  config: ContextPressureConfig | null
): ContextPressureSnapshot | null {
  if (!config || !entry.contextUsage) {
    return null
  }
  return resolveContextPressure({
    usage: entry.contextUsage,
    model: entry.model,
    agentType: entry.agentType,
    config
  })
}

const LEVEL_RANK: Record<ContextPressureLevel, number> = { ok: 0, warning: 1, critical: 2 }

/** Aggregate surfaces (worktree cards, tabs) stay quiet at 'ok' — only
 *  warning/critical earn a dot there; per-agent rows show all three levels. */
export function alertOnlyContextPressure(
  snapshot: ContextPressureSnapshot | null
): ContextPressureSnapshot | null {
  return snapshot && snapshot.level !== 'ok' ? snapshot : null
}

function isMorePressured(
  candidate: ContextPressureSnapshot,
  current: ContextPressureSnapshot
): boolean {
  const byLevel = LEVEL_RANK[candidate.level] - LEVEL_RANK[current.level]
  return byLevel !== 0 ? byLevel > 0 : candidate.usedPercent > current.usedPercent
}

// Why: the per-worktree entries arrays are referentially stable across
// unrelated store publications (reuseArrayIfEqual), so caching on them skips
// the worst-of scan for every mounted card a ping did not touch.
const worstSnapshotByEntries = new WeakMap<
  readonly AgentStatusEntry[],
  { config: ContextPressureConfig; snapshot: ContextPressureSnapshot | null }
>()

/** Worst pressure among the entries ('critical' > 'warning' > 'ok'; ties break
 *  to the higher usedPercent). Sessions without data don't count. */
export function getWorstContextPressureSnapshot(
  entries: readonly AgentStatusEntry[],
  config: ContextPressureConfig
): ContextPressureSnapshot | null {
  const cached = worstSnapshotByEntries.get(entries)
  if (cached && cached.config === config) {
    return cached.snapshot
  }
  let worst: ContextPressureSnapshot | null = null
  for (const entry of entries) {
    const snapshot = resolveEntryContextPressure(entry, config)
    if (snapshot && (!worst || isMorePressured(snapshot, worst))) {
      worst = snapshot
    }
  }
  worstSnapshotByEntries.set(entries, { config, snapshot: worst })
  return worst
}

type TabPressureIndexCache = {
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  config: ContextPressureConfig
  byTabId: Map<string, ContextPressureSnapshot>
}

let tabPressureIndexCache: TabPressureIndexCache | null = null

/** Worst pressure per tab (a tab can host several panes). Built once per store
 *  version and shared by every mounted tab, not rescanned per tab. */
export function buildTabContextPressureIndex(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  config: ContextPressureConfig
): Map<string, ContextPressureSnapshot> {
  if (
    tabPressureIndexCache &&
    tabPressureIndexCache.agentStatusByPaneKey === agentStatusByPaneKey &&
    tabPressureIndexCache.config === config
  ) {
    return tabPressureIndexCache.byTabId
  }
  const byTabId = new Map<string, ContextPressureSnapshot>()
  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
    const snapshot = resolveEntryContextPressure(entry, config)
    if (!snapshot) {
      continue
    }
    // Why parsePaneKey: also drops legacy/synthetic keys that only look pane-shaped.
    const parsed = parsePaneKey(paneKey)
    if (!parsed) {
      continue
    }
    const current = byTabId.get(parsed.tabId)
    if (!current || isMorePressured(snapshot, current)) {
      byTabId.set(parsed.tabId, snapshot)
    }
  }
  tabPressureIndexCache = { agentStatusByPaneKey, config, byTabId }
  return byTabId
}

// Why tuples: snapshot objects are rebuilt per store version; useShallow over
// their primitive fields keeps subscribers stable when the values didn't move.
type PressureTuple = readonly [
  ContextPressureLevel,
  number,
  number,
  number,
  ContextPressureLimitSource,
  ContextPressureSnapshot['usedTokensSource']
]

function toPressureTuple(snapshot: ContextPressureSnapshot | null): PressureTuple | null {
  return snapshot
    ? ([
        snapshot.level,
        snapshot.usedTokens,
        snapshot.limitTokens,
        snapshot.usedPercent,
        snapshot.limitSource,
        snapshot.usedTokensSource
      ] as const)
    : null
}

function useSnapshotFromTuple(tuple: PressureTuple | null): ContextPressureSnapshot | null {
  return useMemo(
    () =>
      tuple
        ? {
            level: tuple[0],
            usedTokens: tuple[1],
            limitTokens: tuple[2],
            usedPercent: tuple[3],
            limitSource: tuple[4],
            usedTokensSource: tuple[5]
          }
        : null,
    [tuple]
  )
}

// migrationUnsupported/retained satisfy the selector's state type; only the
// live map and tabs actually feed the pressure scan.
type WorktreePressureState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'retainedAgentsByPaneKey'
  | 'tabsByWorktree'
  | 'settings'
>

/** Worst-of pressure for a worktree's live agents, or null when the master
 *  flag is off, `active` is false, or no session has data. `alertOnly` also
 *  filters 'ok' INSIDE the selector, so ok-level drift never re-renders the card. */
export function useWorktreeContextPressure(
  worktreeId: string,
  active = true,
  alertOnly = false
): ContextPressureSnapshot | null {
  const tuple = useAppStore(
    useShallow((s: WorktreePressureState): PressureTuple | null => {
      if (!active) {
        return null
      }
      const config = getContextPressureConfig(s.settings)
      if (!config) {
        return null
      }
      const worst = getWorstContextPressureSnapshot(
        selectLiveAgentStatusEntriesForWorktree(s, worktreeId),
        config
      )
      return toPressureTuple(alertOnly ? alertOnlyContextPressure(worst) : worst)
    })
  )
  return useSnapshotFromTuple(tuple)
}

const EMPTY_AGENT_STATUS: Record<string, AgentStatusEntry> = {}

/** Worst-of pressure across a terminal tab's panes (for the tab strip). Tabs
 *  are an aggregate surface: only warning/critical are reported ('ok' → null). */
export function useTabContextPressure(tabId: string): ContextPressureSnapshot | null {
  const tuple = useAppStore(
    useShallow((s: Pick<AppState, 'agentStatusByPaneKey' | 'settings'>): PressureTuple | null => {
      const config = getContextPressureConfig(s.settings)
      if (!config) {
        return null
      }
      return toPressureTuple(
        alertOnlyContextPressure(
          buildTabContextPressureIndex(s.agentStatusByPaneKey ?? EMPTY_AGENT_STATUS, config).get(
            tabId
          ) ?? null
        )
      )
    })
  )
  return useSnapshotFromTuple(tuple)
}
