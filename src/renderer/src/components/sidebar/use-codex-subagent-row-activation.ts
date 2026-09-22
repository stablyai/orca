import { useCallback } from 'react'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { useAppStore } from '@/store'
import { createCodexSubagentProgressTarget } from './codex-subagent-progress-target'
import { selectCodexSubagentProgressHostAuthority } from './codex-subagent-progress-host-authority'

/** Row activation for sidebar agent rows: Codex child rows open the live progress
 *  sheet; every other row keeps the normal tab/retained handler. */
export function useCodexSubagentRowActivation({
  worktreeId,
  activateTab,
  activateRetained
}: {
  worktreeId: string
  activateTab: (tabId: string, paneKey: string) => void
  activateRetained: () => void
}): (agent: DashboardAgentRow) => (tabId: string, paneKey: string) => void {
  const openModal = useAppStore((s) => s.openModal)
  const openProgress = useCallback(
    (agent: DashboardAgentRow) => {
      const hostAuthority = selectCodexSubagentProgressHostAuthority(useAppStore.getState(), {
        worktreeId,
        parentPaneKey: agent.subagentSession?.parentPaneKey ?? agent.paneKey,
        tabPtyId: agent.tab.ptyId,
        connectionId: agent.entry.connectionId
      })
      const target = createCodexSubagentProgressTarget(agent, worktreeId, hostAuthority)
      // Why: an unresolvable target (legacy SSH / unknown owner) falls back to focusing the parent pane.
      if (target) {
        openModal('codex-subagent-progress', target)
      } else {
        activateTab(agent.tab.id, agent.activationPaneKey ?? agent.paneKey)
      }
    },
    [worktreeId, activateTab, openModal]
  )
  return useCallback(
    (agent: DashboardAgentRow) =>
      agent.rowSource === 'retained'
        ? activateRetained
        : agent.subagentSession?.provider === 'codex'
          ? () => openProgress(agent)
          : activateTab,
    [activateRetained, activateTab, openProgress]
  )
}
