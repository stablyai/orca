import type { TerminalTab, TuiAgent, Worktree } from '../../../shared/types'
import type { AgentStatusState, AgentType } from '../../../shared/agent-status-types'
import { tabHasLivePty } from './tab-has-live-pty'
import type { WorktreeStatus } from './worktree-status'
import { tuiAgentToAgentKind } from '../../../shared/agent-kind'
import type { AgentKind } from '../../../shared/telemetry-events'

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

// Re-export: shared so mobile shows the same agent labels; kept here for existing importers.
export { formatAgentTypeLabel } from '../../../shared/agent-type-label'

// Why: Record<TuiAgent, true> (not a Set) forces a build error if a TuiAgent member is added without being listed here.
const ICONABLE_AGENT_TYPES: Record<TuiAgent, true> = {
  claude: true,
  'claude-agent-teams': true,
  openclaude: true,
  codex: true,
  autohand: true,
  opencode: true,
  'mimo-code': true,
  pi: true,
  omp: true,
  gemini: true,
  antigravity: true,
  aider: true,
  goose: true,
  amp: true,
  kilo: true,
  kiro: true,
  crush: true,
  aug: true,
  cline: true,
  codebuff: true,
  'command-code': true,
  continue: true,
  cursor: true,
  droid: true,
  kimi: true,
  'mistral-vibe': true,
  'qwen-code': true,
  rovo: true,
  hermes: true,
  openclaw: true,
  copilot: true,
  grok: true,
  devin: true,
  ante: true
}

// Why: return null (not a 'claude' fallback) for unknown so Codex panes don't flash the Claude icon before the hook fires.
export function agentTypeToIconAgent(agentType: AgentType | null | undefined): TuiAgent | null {
  if (!agentType || agentType === 'unknown') {
    return null
  }
  return Object.prototype.hasOwnProperty.call(ICONABLE_AGENT_TYPES, agentType)
    ? (agentType as TuiAgent)
    : null
}

// Why: shared resolver so all send paths stamp identical agent_kind on agent_prompt_sent telemetry.
export function agentKindForAgentType(agentType: AgentType | null | undefined): AgentKind {
  const tuiAgent = agentTypeToIconAgent(agentType)
  return tuiAgent ? tuiAgentToAgentKind(tuiAgent) : 'other'
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
