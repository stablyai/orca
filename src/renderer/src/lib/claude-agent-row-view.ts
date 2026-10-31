import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { hostRouteForAuthority } from '@/runtime/runtime-client-target'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { resolveOwnerOrLocal } from './worktree-runtime-owner'
import { findActiveRuntimeTerminal } from './active-agent-note-target'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { authorityKey } from '../../../shared/host-authority'
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
  // A newer click owns this pane even while terminal resolution or a local RPC is still pending.
  pendingViews.get(paneKey)?.abort()
  const intent = new AbortController()
  pendingViews.set(paneKey, intent)
  const latest = () => pendingViews.get(paneKey) === intent
  let current = latest
  try {
    const parsed = parsePaneKey(paneKey)
    const sessionId = parent.providerSession?.id
    const owner = resolveOwnerOrLocal(state, { workspaceId: agent.tab.worktreeId })
    const agentId = child ? (agent.childRow?.providerId ?? agent.childRow?.id) : undefined
    if (!parsed || !sessionId || owner.kind !== 'resolved' || (!parentDestination && !agentId)) {
      if (child) {
        toast.info(viewFailure(parentDestination))
      }
      return
    }
    const { target } = hostRouteForAuthority(owner.owner)
    const revision =
      target.kind === 'environment'
        ? getRuntimeEnvironmentRevision(target.environmentId)
        : undefined
    const ptyId = state.terminalLayoutsByTabId[parsed.tabId]?.ptyIdsByLeafId?.[parsed.leafId]
    current = () => {
      const now = useAppStore.getState()
      const liveParent = now.agentStatusByPaneKey[paneKey]
      const liveOwner = resolveOwnerOrLocal(now, { workspaceId: agent.tab.worktreeId })
      return (
        latest() &&
        !intent.signal.aborted &&
        liveParent?.agentType === 'claude' &&
        !liveParent.structuredHostOwned &&
        liveParent.paneKey === paneKey &&
        liveParent.providerSession?.id === sessionId &&
        liveOwner.kind === 'resolved' &&
        authorityKey(liveOwner.owner) === authorityKey(owner.owner) &&
        (target.kind === 'local' ||
          (revision !== undefined &&
            getRuntimeEnvironmentRevision(target.environmentId) === revision)) &&
        now.terminalLayoutsByTabId[parsed.tabId]?.ptyIdsByLeafId?.[parsed.leafId] === ptyId
      )
    }
    const options = {
      signal: intent.signal,
      expectedEnvironmentPairingRevision: revision,
      beforeSend: () => {
        if (!current()) {
          throw new Error('Claude view action superseded')
        }
      }
    }
    if (!current()) {
      if (child) {
        toast.info(viewFailure(parentDestination))
      }
      return
    }
    const terminal = await findActiveRuntimeTerminal(
      target,
      agent.tab.worktreeId,
      parsed,
      3000,
      options
    )
    if (!current()) {
      return
    }
    if (!terminal) {
      if (child) {
        toast.info(viewFailure(parentDestination))
      }
      return
    }
    const view = () =>
      callRuntimeRpc<{ view: ClaudeAgentViewResult }>(
        target,
        'terminal.viewClaudeAgent',
        {
          terminal: terminal.handle,
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
    if (latest()) {
      pendingViews.delete(paneKey)
    }
    intent.abort()
  }
}
