import type { BuiltInTuiAgent, TerminalTab, TuiAgent, Worktree } from '../../../shared/types'
import type { AgentStatusState, AgentType } from '../../../shared/agent-status-types'
import { tabHasLivePty } from './tab-has-live-pty'
import type { WorktreeStatus } from './worktree-status'
import { tuiAgentToAgentKind } from '../../../shared/agent-kind'
import { isCustomTuiAgentId } from '../../../shared/custom-tui-agents'
import { isBuiltInTuiAgent } from '../../../shared/tui-agent-config'
import { customAgentSettingsBase, customAgentSettingsLabel } from './custom-agent-settings-index'
import type { AgentKind } from '../../../shared/telemetry-events'
import { getAgentCatalogSettings } from './agent-catalog-settings-source'
// Built-in labels live in shared so mobile shows the same names.
import { formatAgentTypeLabel as formatBuiltInAgentTypeLabel } from '../../../shared/agent-type-label'

// Re-export from shared so existing renderer imports work; main process now shares the detection logic.
export {
  type AgentStatus,
  detectAgentStatusFromTitle,
  clearWorkingIndicators,
  createAgentStatusTracker,
  normalizeTerminalTitle,
  isGeminiTerminalTitle,
  isClaudeAgent,
  isClaudeManagementTitle,
  getAgentLabel
} from '../../../shared/agent-detection'
import type { AgentStatus } from '../../../shared/agent-detection'
import { classifyTitleActivity, resolveTitleActivityLabel } from './pane-agent-evidence'

type AgentQueryArgs = {
  tabsByWorktree: Record<string, TerminalTab[]>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  // Why: gates title-scraped activity on liveness — preserved-under-sleep titles would otherwise surface slept tabs as working.
  ptyIdsByTabId: Record<string, string[]>
  worktreesByRepo: Record<string, Worktree[]>
}

export type WorkingAgentEntry = {
  label: string
  status: AgentStatus
  tabId: string
  paneId: number | null
}

export type WorktreeAgents = {
  agents: WorkingAgentEntry[]
}

export function getWorkingAgentsPerWorktree({
  tabsByWorktree,
  runtimePaneTitlesByTabId,
  ptyIdsByTabId,
  worktreesByRepo
}: AgentQueryArgs): Record<string, WorktreeAgents> {
  const validIds = collectWorktreeIds(worktreesByRepo)
  const result: Record<string, WorktreeAgents> = {}

  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    // Why: tabsByWorktree can retain orphaned entries for deleted worktrees; worktreesByRepo is the source of truth.
    if (!validIds.has(worktreeId)) {
      continue
    }
    const agents: WorkingAgentEntry[] = []

    for (const tab of tabs) {
      // Why: pane titles are preserved under sleep (keepIdentifiers), so gate on live PTY or slept tabs surface as working agents.
      if (!tabHasLivePty(ptyIdsByTabId, tab.id)) {
        continue
      }
      const paneTitles = runtimePaneTitlesByTabId[tab.id]
      if (paneTitles && Object.keys(paneTitles).length > 0) {
        for (const [paneIdStr, title] of Object.entries(paneTitles)) {
          if (classifyTitleActivity(title) === 'working') {
            const label = resolveTitleActivityLabel(title)
            if (label) {
              agents.push({
                label,
                status: 'working',
                tabId: tab.id,
                paneId: Number(paneIdStr)
              })
            }
          }
        }
      } else if (classifyTitleActivity(tab.title) === 'working') {
        const label = resolveTitleActivityLabel(tab.title)
        if (label) {
          agents.push({ label, status: 'working', tabId: tab.id, paneId: null })
        }
      }
    }

    if (agents.length > 0) {
      result[worktreeId] = { agents }
    }
  }

  return result
}

/** Label for a pane's `agentType`, which carries the REQUESTED id — a custom
 *  agent shows its own catalog name (live or tombstoned), never the raw
 *  `custom-agent:<base>:<uuid>` string and never its base harness's name. */
export function formatAgentTypeLabel(agentType: AgentType | null | undefined): string {
  if (!isCustomTuiAgentId(agentType)) {
    return formatBuiltInAgentTypeLabel(agentType)
  }
  // Per-row render path: O(1) memoized index, not a catalog scan per row.
  const label = customAgentSettingsLabel(getAgentCatalogSettings(), agentType)
  // An id the catalog cannot name is an unknown agent, not a printable id.
  return label?.trim() || formatBuiltInAgentTypeLabel(null)
}

// Why: return null (not a 'claude' fallback) for unknown so Codex panes don't flash the Claude icon before the hook fires.
// Icon, label, and telemetry registries are all built-in-only, so a custom agent
// id resolves to its catalog-proven base harness first; an id the catalog cannot
// prove (unknown string, tombstone-less custom id) stays null.
function resolveAgentTypeBaseAgent(
  agentType: AgentType | null | undefined
): BuiltInTuiAgent | null {
  if (!agentType || agentType === 'unknown') {
    return null
  }
  // AgentType is an open string; membership is validated here and anything
  // outside the catalog returns null. Custom ids resolve through the memoized
  // O(1) index (per-row render path), matching resolveTuiAgentBaseAgent.
  if (isBuiltInTuiAgent(agentType)) {
    return agentType
  }
  if (!isCustomTuiAgentId(agentType)) {
    return null
  }
  return customAgentSettingsBase(getAgentCatalogSettings(), agentType)
}

export function agentTypeToIconAgent(agentType: AgentType | null | undefined): TuiAgent | null {
  return resolveAgentTypeBaseAgent(agentType)
}

// Why: shared resolver so all send paths stamp identical agent_kind on agent_prompt_sent telemetry.
export function agentKindForAgentType(agentType: AgentType | null | undefined): AgentKind {
  const baseAgent = resolveAgentTypeBaseAgent(agentType)
  return baseAgent ? tuiAgentToAgentKind(baseAgent) : 'other'
}

// Re-export: freshness gate moved into pane-agent-evidence; keeps existing importers unchanged.
export { isExplicitAgentStatusFresh } from './pane-agent-evidence'

/**
 * Map an explicit AgentStatusState to the visual Status used by
 * StatusIndicator and WorktreeCard.
 *
 * | Explicit State | Visual Status | Meaning                        |
 * |----------------|---------------|--------------------------------|
 * | working        | working       | agent actively executing       |
 * | blocked        | permission    | agent needs user attention     |
 * | waiting        | permission    | agent needs user attention     |
 * | done           | done          | task complete but pane live    |
 */
export function mapAgentStatusStateToVisualStatus(state: AgentStatusState): WorktreeStatus {
  switch (state) {
    case 'working':
      return 'working'
    case 'blocked':
    case 'waiting':
      return 'permission'
    case 'done':
      return 'done'
  }
}

export function countWorkingAgents({
  tabsByWorktree,
  runtimePaneTitlesByTabId,
  ptyIdsByTabId,
  worktreesByRepo
}: AgentQueryArgs): number {
  const validIds = collectWorktreeIds(worktreesByRepo)
  let count = 0

  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    if (!validIds.has(worktreeId)) {
      continue
    }
    for (const tab of tabs) {
      count += countWorkingAgentsForTab(tab, runtimePaneTitlesByTabId, ptyIdsByTabId)
    }
  }

  return count
}

function collectWorktreeIds(worktreesByRepo: Record<string, Worktree[]>): Set<string> {
  const ids = new Set<string>()
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const wt of worktrees) {
      ids.add(wt.id)
    }
  }
  return ids
}

function countWorkingAgentsForTab(
  tab: TerminalTab,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>,
  ptyIdsByTabId: Record<string, string[]>
): number {
  // Why: pane titles are preserved under sleep (keepIdentifiers), so gate on live PTY or slept tabs inflate the agent count.
  if (!tabHasLivePty(ptyIdsByTabId, tab.id)) {
    return 0
  }
  let count = 0
  const paneTitles = runtimePaneTitlesByTabId[tab.id]
  // Why: split-pane tabs host multiple agents; the tab title only shows the last pane update, so prefer pane titles when mounted.
  if (paneTitles && Object.keys(paneTitles).length > 0) {
    for (const title of Object.values(paneTitles)) {
      if (classifyTitleActivity(title) === 'working') {
        count += 1
      }
    }
    return count
  }
  if (classifyTitleActivity(tab.title) === 'working') {
    count += 1
  }
  return count
}
