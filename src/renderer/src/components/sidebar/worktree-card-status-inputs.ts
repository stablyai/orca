import type { AppState } from '@/store/types'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import { createWorktreeRecordSelector } from '@/store/worktree-record-selector-cache'

// Why: these selectors return fresh maps whose top-level values preserve
// underlying per-tab references, so callers must compare them shallowly.

// Why frozen: one instance is shared by every card, so a stray write would leak
// across worktrees instead of failing locally.
export const EMPTY_RUNTIME_PANE_TITLES: Record<string, Record<number, string>> = Object.freeze({})
export const EMPTY_LIVE_PTY_IDS: Record<string, string[]> = Object.freeze({})
export const EMPTY_PANE_FOREGROUND_AGENTS: Record<string, PaneForegroundAgentEntry> = Object.freeze(
  {}
)
export const EMPTY_TERMINAL_LAYOUT_ROOTS: Record<
  string,
  TerminalPaneLayoutNode | null | undefined
> = Object.freeze({})

type WorktreeCardStatusInputState = Pick<AppState, 'runtimePaneTitlesByTabId' | 'ptyIdsByTabId'> & {
  tabsByWorktree: Record<string, readonly { id: string }[]>
}

type WorktreeCardForegroundInputState = Partial<Pick<AppState, 'paneForegroundAgentByPaneKey'>> & {
  tabsByWorktree: Record<string, readonly { id: string }[]>
}

type WorktreeCardLayoutRootInputState = Pick<AppState, 'terminalLayoutsByTabId'> & {
  tabsByWorktree: Record<string, readonly { id: string }[]>
}

export const selectRuntimePaneTitlesForWorktree = createWorktreeRecordSelector<
  WorktreeCardStatusInputState,
  Record<string, Record<number, string>>
>({
  readSources: (state) => [state.tabsByWorktree, state.runtimePaneTitlesByTabId],
  empty: EMPTY_RUNTIME_PANE_TITLES,
  build: (state, worktreeId) => {
    const out: Record<string, Record<number, string>> = {}
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      const paneTitles = state.runtimePaneTitlesByTabId[tab.id]
      if (paneTitles) {
        out[tab.id] = paneTitles
      }
    }
    return out
  }
})

export const selectLivePtyIdsForWorktree = createWorktreeRecordSelector<
  WorktreeCardStatusInputState,
  Record<string, string[]>
>({
  readSources: (state) => [state.tabsByWorktree, state.ptyIdsByTabId],
  empty: EMPTY_LIVE_PTY_IDS,
  build: (state, worktreeId) => {
    const out: Record<string, string[]> = {}
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      const ids = state.ptyIdsByTabId[tab.id]
      if (ids && ids.length > 0) {
        out[tab.id] = ids
      }
    }
    return out
  }
})

type PaneForegroundAgentsByTabId = ReadonlyMap<
  string,
  readonly [string, PaneForegroundAgentEntry][]
>

// Why: grouped once per map identity so each card walks only its own tabs, not every pane key.
const paneForegroundAgentsByTabIdCache = new WeakMap<
  Record<string, PaneForegroundAgentEntry>,
  PaneForegroundAgentsByTabId
>()

function getPaneForegroundAgentsByTabId(
  entries: Record<string, PaneForegroundAgentEntry>
): PaneForegroundAgentsByTabId {
  const cached = paneForegroundAgentsByTabIdCache.get(entries)
  if (cached) {
    return cached
  }
  const byTabId = new Map<string, [string, PaneForegroundAgentEntry][]>()
  for (const [paneKey, entry] of Object.entries(entries)) {
    const tabId = parsePaneKey(paneKey)?.tabId
    if (!tabId) {
      continue
    }
    const group = byTabId.get(tabId)
    if (group) {
      group.push([paneKey, entry])
    } else {
      byTabId.set(tabId, [[paneKey, entry]])
    }
  }
  paneForegroundAgentsByTabIdCache.set(entries, byTabId)
  return byTabId
}

/** This worktree's pane foreground-process reads, keyed by pane key. */
export const selectPaneForegroundAgentsForWorktree = createWorktreeRecordSelector<
  WorktreeCardForegroundInputState,
  Record<string, PaneForegroundAgentEntry>
>({
  readSources: (state) => [state.tabsByWorktree, state.paneForegroundAgentByPaneKey],
  empty: EMPTY_PANE_FOREGROUND_AGENTS,
  build: (state, worktreeId) => {
    const tabs = state.tabsByWorktree[worktreeId]
    if (!tabs?.length || !state.paneForegroundAgentByPaneKey) {
      return EMPTY_PANE_FOREGROUND_AGENTS
    }
    const byTabId = getPaneForegroundAgentsByTabId(state.paneForegroundAgentByPaneKey)
    const out: Record<string, PaneForegroundAgentEntry> = {}
    for (const tab of tabs) {
      for (const [paneKey, entry] of byTabId.get(tab.id) ?? []) {
        out[paneKey] = entry
      }
    }
    return out
  }
})

export const selectTerminalLayoutRootsForWorktree = createWorktreeRecordSelector<
  WorktreeCardLayoutRootInputState,
  Record<string, TerminalPaneLayoutNode | null | undefined>
>({
  readSources: (state) => [state.tabsByWorktree, state.terminalLayoutsByTabId],
  empty: EMPTY_TERMINAL_LAYOUT_ROOTS,
  build: (state, worktreeId) => {
    const out: Record<string, TerminalPaneLayoutNode | null | undefined> = {}
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      out[tab.id] = state.terminalLayoutsByTabId[tab.id]?.root
    }
    return out
  }
})

export function selectTerminalLayoutRootsForWorktrees(
  state: WorktreeCardLayoutRootInputState,
  worktreeIds: readonly string[]
): Record<string, TerminalPaneLayoutNode | null | undefined> {
  const out: Record<string, TerminalPaneLayoutNode | null | undefined> = {}
  for (const worktreeId of worktreeIds) {
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      out[tab.id] = state.terminalLayoutsByTabId[tab.id]?.root
    }
  }
  return out
}
