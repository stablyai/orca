import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import type { AgentStatusState } from '../../../shared/agent-status-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { isForeignMachineCodexPtyId } from './codex-pane-selection-lane'
import {
  planAgentSessionRestarts,
  type AgentSessionRestartPane,
  type AgentSessionRestartSkipReason,
  type AgentSessionRestartPlan
} from './agent-session-restart-plan'

export type AgentSessionRestartStatusSnapshot = {
  agentType?: string
  state: AgentStatusState
  providerSession?: AgentProviderSessionMetadata | null
  structuredHostOwned?: true
  restoredUnconfirmed?: boolean
  terminalResumeEligible?: false
}

export type AgentSessionRestartCollectInput = {
  tabsByWorktree: Readonly<
    Record<string, readonly { id: string; generation?: number; worktreeId?: string }[] | undefined>
  >
  terminalLayoutsByTabId: Readonly<
    Record<string, { ptyIdsByLeafId?: Record<string, string> } | undefined>
  >
  ptyIdsByTabId: Readonly<Record<string, readonly string[] | undefined>>
  agentStatusByPaneKey: Readonly<Record<string, AgentSessionRestartStatusSnapshot | undefined>>
  enabledCatalog: readonly TuiAgent[]
  workspaceLabel: (worktreeId: string) => string
  /** Null means the host is unknown. Callers must not substitute local. */
  executionHostId: (worktreeId: string) => string | null
  wsl: (worktreeId: string) => boolean
  foreignPty?: (ptyId: string) => boolean
  shellForeground?: (paneKey: string) => boolean
  startupUnavailableReason?: (
    pane: AgentSessionRestartPane
  ) => AgentSessionRestartSkipReason | undefined
  ompResumeFilePath?: (paneKey: string) => string | null
}

/** Live agent panes only. Shells and ptys with no layout leaf are omitted, not killed. */
export function collectAgentSessionRestartPlan(
  input: AgentSessionRestartCollectInput
): AgentSessionRestartPlan {
  const foreignPty = input.foreignPty ?? isForeignMachineCodexPtyId
  const panes: AgentSessionRestartPane[] = []
  for (const [worktreeId, tabs] of Object.entries(input.tabsByWorktree)) {
    for (const tab of tabs ?? []) {
      const bound = new Set(input.ptyIdsByTabId[tab.id] ?? [])
      const leaves = input.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
      for (const [leafId, ptyId] of Object.entries(leaves)) {
        if (!isTerminalLeafId(leafId) || !ptyId || !bound.has(ptyId)) {
          continue
        }
        const paneKey = makePaneKey(tab.id, leafId)
        const status = input.agentStatusByPaneKey[paneKey]
        if (!status?.agentType) {
          continue
        }
        const pane: AgentSessionRestartPane = {
          ptyId,
          tabId: tab.id,
          leafId,
          worktreeId: tab.worktreeId ?? worktreeId,
          workspaceLabel: input.workspaceLabel(worktreeId),
          tabGeneration: tab.generation ?? 0,
          agent: status.agentType,
          providerSession: status.providerSession ?? null,
          state: status.state,
          structuredHostOwned: status.structuredHostOwned === true,
          restoredUnconfirmed: status.restoredUnconfirmed === true,
          ...(status.terminalResumeEligible === false
            ? { terminalResumeEligible: false as const }
            : {}),
          shellForeground: input.shellForeground?.(paneKey) === true,
          ompResumeFilePath: input.ompResumeFilePath?.(paneKey) ?? null,
          executionHostId: input.executionHostId(worktreeId),
          foreignPty: foreignPty(ptyId),
          wsl: input.wsl(worktreeId)
        }
        pane.startupUnavailableReason = input.startupUnavailableReason?.(pane)
        panes.push(pane)
      }
    }
  }
  return planAgentSessionRestarts({ panes, enabledCatalog: input.enabledCatalog })
}
