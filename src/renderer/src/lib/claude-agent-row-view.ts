import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from './worktree-runtime-owner'
import { findActiveRuntimeTerminal } from './active-agent-note-target'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { ClaudeAgentViewResult } from '../../../shared/claude-agent-view'

export async function viewClaudeAgentFromRow(agent: DashboardAgentRow): Promise<void> {
  const state = useAppStore.getState()
  const paneKey = agent.activationPaneKey ?? agent.paneKey
  const parent = state.agentStatusByPaneKey[paneKey] ?? agent.entry
  if (parent?.agentType !== 'claude' || parent.structuredHostOwned) {
    return
  }
  const parsed = parsePaneKey(paneKey)
  const sessionId = parent.providerSession?.id
  if (!parsed || !sessionId) {
    return
  }
  const child = agent.rowSource === 'subagent'
  const agentId = child ? (agent.childRow?.providerId ?? agent.childRow?.id) : undefined
  if (child && !agentId) {
    return
  }
  try {
    const target = runtimeTargetForOwnerEnvironment(
      runtimeEnvironmentIdOrLocalUnlessTwin(state, agent.tab.worktreeId)
    )
    const terminal = await findActiveRuntimeTerminal(
      target,
      agent.tab.worktreeId,
      {
        tabId: parsed.tabId,
        leafId: parsed.leafId
      },
      3000
    )
    if (!terminal) {
      return
    }
    const { view } = await callRuntimeRpc<{ view: ClaudeAgentViewResult }>(
      target,
      'terminal.viewClaudeAgent',
      {
        terminal: terminal.handle,
        sessionId,
        ...(agentId ? { agentId } : {}),
        client: { id: 'orca-desktop', type: 'desktop' }
      },
      { timeoutMs: 8000 }
    )
    if (view.status === 'viewed' || view.status === 'busy' || !child) {
      return
    }
    if (view.status === 'unsupported') {
      toast.info(
        translate(
          'auto.lib.claudeAgentRowView.subagentNavigationSetup',
          'Enable Claude subagent navigation in Settings → Agents, then launch Claude 2.1.300+ in Orca. Check that keybindings.json still binds Ctrl+Alt+G, H, or V to command:orca-agent-view.'
        )
      )
    } else if (view.status === 'permission') {
      toast.info(
        translate(
          'auto.lib.claudeAgentRowView.permissionPrompt',
          'Answer Claude’s permission prompt before switching agents.'
        )
      )
    } else if (view.status === 'denied') {
      toast.info(
        view.reason ??
          translate(
            'auto.lib.claudeAgentRowView.agentUnavailable',
            'Claude cannot open this agent. It may no longer be available.'
          )
      )
    } else {
      toast.info(
        translate(
          'auto.lib.claudeAgentRowView.closeDialog',
          'Claude did not switch views. Close any open dialog and try again.'
        )
      )
    }
  } catch {
    if (child) {
      toast.info(
        translate(
          'auto.lib.claudeAgentRowView.hostUnavailable',
          'Subagent navigation is unavailable on this host. Update Orca and restart Claude in this pane.'
        )
      )
    }
  }
}
