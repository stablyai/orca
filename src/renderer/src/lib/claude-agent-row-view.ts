import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { findAgentRowParentTerminal, startAgentRowIntent } from './agent-row-parent-terminal'
import type { ClaudeAgentViewResult } from '../../../shared/claude-agent-view'

const pendingViews = new Map<string, AbortController>()

export function opensClaudeParentConversation(
  agent: Pick<DashboardAgentRow, 'rowSource' | 'childRow'>
): boolean {
  return agent.rowSource === 'subagent' && agent.childRow?.agentType === 'workflow-subagent'
}

function viewFailure(parent: boolean): string {
  return parent
    ? translate(
        'auto.lib.claudeAgentRowView.parentViewFailed',
        'Claude could not open the parent conversation. Try again in the Claude pane.'
      )
    : translate(
        'auto.lib.claudeAgentRowView.childViewFailed',
        'Claude could not open this agent. Try again in the Claude pane.'
      )
}

export async function viewClaudeAgentFromRow(agent: DashboardAgentRow): Promise<void> {
  const state = useAppStore.getState()
  const paneKey = agent.activationPaneKey ?? agent.paneKey
  const parent = state.agentStatusByPaneKey[paneKey] ?? agent.entry
  if (parent.agentType !== 'claude' || parent.structuredHostOwned) {
    return
  }
  const child = agent.rowSource === 'subagent'
  let parentDestination = !child || opensClaudeParentConversation(agent)
  const intent = startAgentRowIntent(pendingViews, paneKey)
  let current = intent.latest
  try {
    const sessionId = parent.providerSession?.id
    const agentId = child ? (agent.childRow?.providerId ?? agent.childRow?.id) : undefined
    if (!sessionId || (!parentDestination && !agentId)) {
      if (child) {
        toast.info(viewFailure(parentDestination))
      }
      return
    }
    const parentTerminal = await findAgentRowParentTerminal({
      intent,
      agentType: 'claude',
      paneKey,
      worktreeId: agent.tab.worktreeId,
      sessionId
    })
    if (parentTerminal.status !== 'found') {
      if (child && parentTerminal.status === 'unavailable') {
        toast.info(viewFailure(parentDestination))
      }
      return
    }
    const { target, options } = parentTerminal
    current = parentTerminal.current
    const view = () =>
      callRuntimeRpc<{ view: ClaudeAgentViewResult }>(
        target,
        'terminal.viewClaudeAgent',
        {
          terminal: parentTerminal.handle,
          sessionId,
          ...(!parentDestination ? { agentId } : {}),
          client: { id: 'orca-desktop', type: 'desktop' }
        },
        { timeoutMs: 8000, ...options }
      )
    let result = (await view()).view
    if (!current()) {
      return
    }
    if (!parentDestination && result.status === 'denied') {
      parentDestination = true
      result = (await view()).view
      if (!current()) {
        return
      }
    }
    if (!child || result.status === 'viewed' || result.status === 'busy') {
      return
    }
    if (result.status === 'permission') {
      toast.info(
        translate(
          'auto.lib.claudeAgentRowView.permissionPrompt',
          'Answer Claude’s permission prompt before switching agents.'
        )
      )
    } else if (result.status === 'unsupported') {
      toast.info(
        parentDestination
          ? translate(
              'auto.lib.claudeAgentRowView.parentNavigationSetup',
              'Claude could not open the parent conversation. Enable subagent navigation in Settings → Agents, then restart Claude in this pane.'
            )
          : translate(
              'auto.lib.claudeAgentRowView.subagentNavigationSetup',
              'Enable Claude subagent navigation in Settings → Agents, then launch Claude 2.1.300+ in Orca. Check that keybindings.json still binds Ctrl+Alt+G, H, or V to command:orca-agent-view.'
            )
      )
    } else {
      toast.info(viewFailure(parentDestination))
    }
  } catch {
    if (child && current()) {
      toast.info(viewFailure(parentDestination))
    }
  } finally {
    intent.finish()
  }
}
