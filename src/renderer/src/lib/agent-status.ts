import type { TerminalTab, TuiAgent, Worktree } from '../../../shared/types'
import type {
  AgentStatusEntry,
  AgentStatusState,
  AgentType
} from '../../../shared/agent-status-types'
import { tabHasLivePty } from './tab-has-live-pty'
import type { WorktreeStatus } from './worktree-status'

// Re-export from shared module so existing renderer imports continue to work.
// Why: the main process now needs the same agent detection logic for stat
// tracking. Moving to shared avoids duplicating the detection code.
export {
  type AgentStatus,
  detectAgentStatusFromTitle,
  clearWorkingIndicators,
  createAgentStatusTracker,
  normalizeTerminalTitle,
  isGeminiTerminalTitle,
  isClaudeAgent,
  getAgentLabel
} from '../../../shared/agent-detection'
import {
  type AgentStatus,
  detectAgentStatusFromTitle,
  getAgentLabel
} from '../../../shared/agent-detection'

type AgentQueryArgs = {
  tabsByWorktree: Record<string, TerminalTab[]>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  // Why: title-scraped agent activity (pane titles, tab.title) survives sleep
  // because runtimePaneTitlesByTabId is intentionally preserved under
  // keepIdentifiers for wake recovery. Without the live-PTY map, slept tabs
  // whose preserved titles still match a working pattern would surface as
  // working agents through the title-bar count, dock badge, and per-worktree
  // aggregates. Threading ptyIdsByTabId lets every title-scrape branch gate
  // on actual liveness (`tabHasLivePty`).
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
    // Why: tabsByWorktree can retain orphaned entries for worktrees that no
    // longer exist in git (e.g. deleted worktrees whose tab cleanup didn't
    // complete, or worktrees removed outside Orca). worktreesByRepo is the
    // source of truth — only include worktrees that still exist.
    if (!validIds.has(worktreeId)) {
      continue
    }
    const agents: WorkingAgentEntry[] = []

    for (const tab of tabs) {
      // Why: title-scraped activity must be gated on actual PTY liveness.
      // runtimePaneTitlesByTabId is preserved under sleep (keepIdentifiers),
      // so a slept tab whose pane titles still match a working pattern would
      // surface as a working agent without this gate.
      if (!tabHasLivePty(ptyIdsByTabId, tab.id)) {
        continue
      }
      const paneTitles = runtimePaneTitlesByTabId[tab.id]
      if (paneTitles && Object.keys(paneTitles).length > 0) {
        for (const [paneIdStr, title] of Object.entries(paneTitles)) {
          if (detectAgentStatusFromTitle(title) === 'working') {
            const label = getAgentLabel(title)
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
      } else if (detectAgentStatusFromTitle(tab.title) === 'working') {
        const label = getAgentLabel(tab.title)
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

const WELL_KNOWN_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  aider: 'Aider',
  pi: 'Pi',
  droid: 'Droid',
  grok: 'Grok'
}

export function formatAgentTypeLabel(agentType: AgentType | null | undefined): string {
  if (!agentType || agentType === 'unknown') {
    return 'Agent'
  }
  // Capitalize well-known names nicely; pass through custom names as-is
  return WELL_KNOWN_LABELS[agentType] ?? agentType
}

// Why: AgentIcon expects a TuiAgent, but AgentType is a broader union
// (WellKnownAgentType | (string & {})) that includes 'unknown' and arbitrary
// strings reported by hook payloads. Return null for the unknown case so
// AgentIcon renders a neutral "?" glyph — using 'claude' as a fallback
// caused Codex panes to briefly show the Claude icon before the hook fired.
// Why: we also guard against arbitrary strings (e.g. a hook reporting
// agentType: "weirdo") by checking membership in an explicit record. A
// blind `as TuiAgent` cast would pass values through that AgentIcon can't
// render, producing a broken icon or falling back to an unrelated glyph.
// Why: modeled as `Record<TuiAgent, true>` rather than a Set so the TypeScript
// compiler fails to build when a TuiAgent member is added to shared/types.ts
// without being added here — a Set<TuiAgent> is structurally permissive and
// would silently accept a subset of the union.
const ICONABLE_AGENT_TYPES: Record<TuiAgent, true> = {
  claude: true,
  codex: true,
  autohand: true,
  opencode: true,
  pi: true,
  gemini: true,
  aider: true,
  goose: true,
  amp: true,
  kilo: true,
  kiro: true,
  crush: true,
  aug: true,
  cline: true,
  codebuff: true,
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
  grok: true
}

export function agentTypeToIconAgent(agentType: AgentType | null | undefined): TuiAgent | null {
  if (!agentType || agentType === 'unknown') {
    return null
  }
  return Object.prototype.hasOwnProperty.call(ICONABLE_AGENT_TYPES, agentType)
    ? (agentType as TuiAgent)
    : null
}

// Why: explicit agent status entries (from hook-based reports) can go stale if
// the agent process exits without sending a final update. This helper lets
// callers decide whether to trust the entry based on a configurable TTL.
export function isExplicitAgentStatusFresh(
  entry: Pick<AgentStatusEntry, 'updatedAt'>,
  now: number,
  staleAfterMs: number
): boolean {
  return now - entry.updatedAt <= staleAfterMs
}

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
  // Why: liveness precondition shared with getWorkingAgentsPerWorktree.
  // runtimePaneTitlesByTabId is preserved under sleep (keepIdentifiers) and
  // tab.ptyId is the wake-hint sessionId, not a liveness signal. Without
  // this gate, slept tabs whose preserved titles still match a working
  // pattern would inflate the title-bar agent count and dock badge.
  if (!tabHasLivePty(ptyIdsByTabId, tab.id)) {
    return 0
  }
  let count = 0
  const paneTitles = runtimePaneTitlesByTabId[tab.id]
  // Why: split-pane tabs can host multiple concurrent agents, but the
  // legacy tab title only reflects the last pane title update that won the
  // tab label. Prefer pane-level titles whenever TerminalPane is mounted,
  // and fall back to the tab title only for tabs we have not mounted yet
  // (for example restored-but-unvisited worktrees).
  if (paneTitles && Object.keys(paneTitles).length > 0) {
    for (const title of Object.values(paneTitles)) {
      if (detectAgentStatusFromTitle(title) === 'working') {
        count += 1
      }
    }
    return count
  }
  if (detectAgentStatusFromTitle(tab.title) === 'working') {
    count += 1
  }
  return count
}
