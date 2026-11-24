import type { AgentStatusRows } from '../../agent-status/contracts/agent-status-rows'
import type { AgentStatusEntry } from '../../agent-status/contracts/agent-status-types'
import type { MigrationUnsupportedPtyEntry } from '../../agent-status/contracts/agent-status-ipc-payload'
import type { TerminalLayoutSnapshot } from '../../workspace-layout/terminal-tab-types'
import type { Worktree } from '../../worktree/types'
import { parsePaneKey } from '../../workspace-layout/stable-pane-id'
import {
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

export function buildSmartAttentionIndexes(
  tabsByWorktree: Record<string, readonly SmartAttentionTab[]> | null,
  agentStatusByPaneKey: AgentStatusRows | undefined,
  migrationUnsupportedByPtyId?: Record<string, MigrationUnsupportedPtyEntry>
): SmartAttentionIndexes {
  const mirroredTabIds = new Set<string>()
  for (const tabs of Object.values(tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      mirroredTabIds.add(tab.id)
    }
  }
  return {
    entriesByTabId: buildExplicitEntriesByTabId(agentStatusByPaneKey, migrationUnsupportedByPtyId),
    entriesByAttributedWorktreeId: buildExplicitEntriesByWorktreeId(agentStatusByPaneKey),
    mirroredTabIds
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
  const tabs = sources.tabsByWorktree?.[worktree.id] ?? []
  // Why: hook stamps can precede tab mirroring; once mirrored, live tab ownership wins so both worktrees aren't promoted.
  const panes: PaneInput[] = (indexes.entriesByAttributedWorktreeId.get(worktree.id) ?? [])
    .filter((entry) => {
      const parsed = parsePaneKey(entry.paneKey)
      return parsed !== null && !indexes.mirroredTabIds.has(parsed.tabId)
    })
    // No mirrored tab means no renderer live-PTY evidence to hold these hooks above Idle.
    .map((entry) => ({ kind: 'hook' as const, entry, hasLivePty: false }))
  if (tabs.length === 0) {
    return resolveAttention(panes, now)
  }
  const paneSources: TabPaneInputSources = {
    entriesByTabId: indexes.entriesByTabId,
    ptyIdsByTabId: sources.ptyIdsByTabId,
    runtimePaneTitlesByTabId: sources.runtimePaneTitlesByTabId,
    terminalLayoutsByTabId: sources.terminalLayoutsByTabId
  }
  for (const tab of tabs) {
    panes.push(...collectTabPaneInputs(tab, worktree.lastActivityAt, paneSources, now))
  }
  return resolveAttention(panes, now)
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
