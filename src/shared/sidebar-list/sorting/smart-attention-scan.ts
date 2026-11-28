import type { AgentStatusRows } from '../../agent-status/contracts/agent-status-rows'
import type { AgentStatusEntry } from '../../agent-status/contracts/agent-status-types'
import type { MigrationUnsupportedPtyEntry } from '../../agent-status/contracts/agent-status-ipc-payload'
import type { TerminalLayoutSnapshot } from '../../workspace-layout/terminal-tab-types'
import type { Worktree } from '../../worktree/types'
import { parsePaneKey } from '../../workspace-layout/stable-pane-id'
import {
  IDLE,
  buildExplicitEntriesByTabId,
  buildExplicitEntriesByWorktreeId,
  collectTabPaneInputs,
  resolveAttention,
  type PaneInput,
  type SmartAttentionTab,
  type TabPaneInputSources,
  type WorktreeAttention
} from './smart-attention'

/** The fleet-wide lookups a Smart scan resolves every workspace against; they depend only on their three inputs. */
export type SmartAttentionIndexes = {
  entriesByTabId: Map<string, AgentStatusEntry[]>
  entriesByAttributedWorktreeId: Map<string, AgentStatusEntry[]>
  mirroredTabIds: ReadonlySet<string>
}

export const EMPTY_MIRRORED_TAB_IDS: ReadonlySet<string> = new Set()

export function buildMirroredTabIds(
  tabsByWorktree: Record<string, readonly SmartAttentionTab[]> | null
): ReadonlySet<string> {
  if (!tabsByWorktree) {
    return EMPTY_MIRRORED_TAB_IDS
  }
  let mirroredTabIds: Set<string> | undefined
  for (const worktreeId in tabsByWorktree) {
    if (!Object.hasOwn(tabsByWorktree, worktreeId)) {
      continue
    }
    const tabs = tabsByWorktree[worktreeId]
    if (tabs.length === 0) {
      continue
    }
    mirroredTabIds ??= new Set<string>()
    for (let i = 0; i < tabs.length; i += 1) {
      mirroredTabIds.add(tabs[i].id)
    }
  }
  return mirroredTabIds ?? EMPTY_MIRRORED_TAB_IDS
}

export function buildSmartAttentionIndexes(
  tabsByWorktree: Record<string, readonly SmartAttentionTab[]> | null,
  agentStatusByPaneKey: AgentStatusRows | undefined,
  migrationUnsupportedByPtyId?: Record<string, MigrationUnsupportedPtyEntry>
): SmartAttentionIndexes {
  const entriesByAttributedWorktreeId = buildExplicitEntriesByWorktreeId(agentStatusByPaneKey)
  return {
    entriesByTabId: buildExplicitEntriesByTabId(agentStatusByPaneKey, migrationUnsupportedByPtyId),
    entriesByAttributedWorktreeId,
    // mirroredTabIds is only consulted for worktrees with attributed agent status entries.
    mirroredTabIds:
      entriesByAttributedWorktreeId.size > 0
        ? buildMirroredTabIds(tabsByWorktree)
        : EMPTY_MIRRORED_TAB_IDS
  }
}

/** One workspace's attention from prebuilt indexes, with per-pane hook authority and live-PTY-gated title fallbacks. */
export function resolveWorktreeAttention(
  worktree: Pick<Worktree, 'id' | 'lastActivityAt'>,
  indexes: SmartAttentionIndexes,
  sources: {
    tabsByWorktree: Record<string, readonly SmartAttentionTab[]> | null
    ptyIdsByTabId: Record<string, string[]>
    runtimePaneTitlesByTabId: Record<string, Record<number, string>>
    terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
  },
  now: number
): WorktreeAttention {
  const tabs = sources.tabsByWorktree?.[worktree.id]
  const attributed = indexes.entriesByAttributedWorktreeId.get(worktree.id)
  const hasTabs = tabs !== undefined && tabs.length > 0
  if (!hasTabs && (!attributed || attributed.length === 0)) {
    return IDLE
  }
  let panes: PaneInput[] | undefined
  // Why: hook stamps can precede tab mirroring; once mirrored, live tab ownership wins so both worktrees aren't promoted.
  if (attributed) {
    for (let i = 0; i < attributed.length; i += 1) {
      const entry = attributed[i]
      const parsed = parsePaneKey(entry.paneKey)
      if (parsed !== null && !indexes.mirroredTabIds.has(parsed.tabId)) {
        // No mirrored tab means no renderer live-PTY evidence to hold these hooks above Idle.
        ;(panes ??= []).push({ kind: 'hook', entry, hasLivePty: false })
      }
    }
  }
  if (!hasTabs) {
    return panes ? resolveAttention(panes, now) : IDLE
  }
  const paneSources: TabPaneInputSources = {
    entriesByTabId: indexes.entriesByTabId,
    ptyIdsByTabId: sources.ptyIdsByTabId,
    runtimePaneTitlesByTabId: sources.runtimePaneTitlesByTabId,
    terminalLayoutsByTabId: sources.terminalLayoutsByTabId
  }
  for (let i = 0; i < tabs.length; i += 1) {
    const tabPanes = collectTabPaneInputs(tabs[i], worktree.lastActivityAt, paneSources, now)
    if (tabPanes.length > 0) {
      panes ??= []
      for (let j = 0; j < tabPanes.length; j += 1) {
        panes.push(tabPanes[j])
      }
    }
  }
  return panes ? resolveAttention(panes, now) : IDLE
}

export const EMPTY_ATTENTION_MAP = new Map<string, WorktreeAttention>()

function isIdleAttention(attention: WorktreeAttention): boolean {
  return attention === IDLE || (attention.cls === 5 && attention.attentionTimestamp === 0)
}

/** Sparse attention map omitting IDLE rows (comparators fall back to IDLE on miss). */
export function buildSparseAttentionByWorktree(
  worktrees: readonly Pick<Worktree, 'id' | 'lastActivityAt'>[],
  sources: {
    tabsByWorktree: Record<string, readonly SmartAttentionTab[]>
    attentionForWorktree?: (
      worktree: Pick<Worktree, 'id' | 'lastActivityAt'>,
      now: number
    ) => WorktreeAttention
    agentStatusByPaneKey: AgentStatusRows
    runtimePaneTitlesByTabId: Record<string, Record<number, string>>
    ptyIdsByTabId: Record<string, string[]>
    migrationUnsupportedByPtyId?: Record<string, MigrationUnsupportedPtyEntry>
    terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
  },
  now: number
): Map<string, WorktreeAttention> {
  let map: Map<string, WorktreeAttention> | undefined
  if (sources.attentionForWorktree) {
    const readAttention = sources.attentionForWorktree
    for (let i = 0; i < worktrees.length; i += 1) {
      const worktree = worktrees[i]
      const attention = readAttention(worktree, now)
      if (!isIdleAttention(attention)) {
        ;(map ??= new Map()).set(worktree.id, attention)
      }
    }
    return map ?? EMPTY_ATTENTION_MAP
  }
  const indexes = buildSmartAttentionIndexes(
    sources.tabsByWorktree,
    sources.agentStatusByPaneKey,
    sources.migrationUnsupportedByPtyId
  )
  for (let i = 0; i < worktrees.length; i += 1) {
    const worktree = worktrees[i]
    const attention = resolveWorktreeAttention(worktree, indexes, sources, now)
    if (!isIdleAttention(attention)) {
      ;(map ??= new Map()).set(worktree.id, attention)
    }
  }
  return map ?? EMPTY_ATTENTION_MAP
}

/** Resolve attention once per workspace with per-pane hook authority and live-PTY-gated title fallbacks. */
export function buildAttentionByWorktree(
  worktrees: readonly Pick<Worktree, 'id' | 'lastActivityAt'>[],
  tabsByWorktree: Record<string, readonly SmartAttentionTab[]> | null,
  agentStatusByPaneKey: AgentStatusRows | undefined,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>,
  ptyIdsByTabId: Record<string, string[]>,
  now: number,
  migrationUnsupportedByPtyId?: Record<string, MigrationUnsupportedPtyEntry>,
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
): Map<string, WorktreeAttention> {
  const indexes = buildSmartAttentionIndexes(
    tabsByWorktree,
    agentStatusByPaneKey,
    migrationUnsupportedByPtyId
  )
  const sources = {
    tabsByWorktree,
    ptyIdsByTabId,
    runtimePaneTitlesByTabId,
    terminalLayoutsByTabId
  }
  const result = new Map<string, WorktreeAttention>()
  for (const worktree of worktrees) {
    result.set(worktree.id, resolveWorktreeAttention(worktree, indexes, sources, now))
  }
  return result
}
