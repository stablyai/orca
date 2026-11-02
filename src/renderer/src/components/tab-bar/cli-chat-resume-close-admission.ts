import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { admitStructuredLaunchOnHost } from '@/lib/agent-session/launch/structured-agent-session-host-admission'
import { structuredChatUnavailableText } from '@/lib/agent-session/launch/structured-agent-session-launch-failure'
import { notifyHostPermissionRefused } from '@/lib/agent-session/launch/structured-agent-session-launch-permission-notice'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { readStructuredChatHostPermissionVerdict } from '@/runtime/structured-chat-host-permission'
import { structuredAgentSessionHostSupports } from '@/runtime/structured-agent-session-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { probePtyRunningWork } from '../terminal/pty-running-work-probe'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { STRUCTURED_AGENT_SESSION_CLOSE_TERMINAL_FOR_CHAT_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import { namesCliConversation } from '../../../../shared/structured-agent-cli-conversation-adoption'
import { recognizeAgentProcess } from '../../../../shared/agent-process-recognition'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { CliChatResumeSource } from './cli-chat-resume-source'
import { reportCliChatResumeOwner } from './cli-chat-resume-feedback'

/** keep: the agent quit, so the terminal stays; close: continuing stops the pane's agent;
 *  ask: the pane runs another job, so the terminal's own running-process prompt asks. */
export type CliChatResumeClose = 'keep' | 'close' | 'ask'

/** Only the host's proof that the pane's shell runs nothing shows its agent quit; a CLI has no status row before its first hook. */
async function paneClose(
  source: CliChatResumeSource,
  signal: AbortSignal
): Promise<CliChatResumeClose> {
  const leafId = source.paneKey.slice(source.tabId.length + 1)
  const ptyId =
    useAppStore.getState().terminalLayoutsByTabId[source.tabId]?.ptyIdsByLeafId?.[leafId]
  // Unbound here is unverifiable, not quit: the close resolves the pane on its host.
  if (!ptyId) {
    return 'close'
  }
  const [probe] = await waitForPromiseWithSignal(
    probePtyRunningWork([ptyId], { timeoutMs: 5_000 }),
    signal
  )
  if (probe?.verdict === 'exited') {
    return 'keep'
  }
  // A job started after the agent quit (an editor, a dev server) is the user's to stop.
  return probe?.verdict === 'live' &&
    probe.foregroundProcess &&
    !recognizeAgentProcess(probe.foregroundProcess)
    ? 'ask'
    : 'close'
}

/** How continuing treats the terminal; null when a check refused and said so, or the source changed. */
export async function admitCliChatResumeClose(
  source: CliChatResumeSource,
  agent: TuiAgent,
  target: RuntimeClientTarget,
  openOwner: boolean,
  isCurrent: () => boolean,
  signal: AbortSignal
): Promise<CliChatResumeClose | null> {
  const closeSupported = await waitForPromiseWithSignal(
    structuredAgentSessionHostSupports(
      target,
      STRUCTURED_AGENT_SESSION_CLOSE_TERMINAL_FOR_CHAT_RUNTIME_CAPABILITY
    ),
    signal
  )
  // An agent that already quit leaves nothing to stop, so its terminal stays and main's create runs.
  const close = closeSupported ? await paneClose(source, signal) : 'keep'
  if (!isCurrent()) {
    return null
  }
  if (close === 'keep') {
    return close
  }
  const state = useAppStore.getState()
  // Main's answer to a chat that already holds the conversation; the host's create judges terminals.
  const ownerRow = Object.values(state.agentStatusByPaneKey).find(
    (row) =>
      row.terminalResumeEligible === false &&
      !!row.worktreeId &&
      getExecutionHostIdForWorktree(state, row.worktreeId) === source.executionHostId &&
      namesCliConversation(row, agent, source.providerSessionId)
  )
  const ownerTab = ownerRow?.worktreeId
    ? state.unifiedTabsByWorktree[ownerRow.worktreeId]?.find((tab) => tab.id === ownerRow.tabId)
    : undefined
  if (ownerRow?.worktreeId && ownerTab) {
    await reportCliChatResumeOwner(
      { sessionId: ownerTab.entityId, workspaceId: ownerRow.worktreeId },
      openOwner,
      target
    )
    return null
  }
  const support = await waitForPromiseWithSignal(
    admitStructuredLaunchOnHost(target, toRuntimeWorktreeSelector(source.workspaceId), agent),
    signal
  )
  if (!isCurrent()) {
    return null
  }
  if (support.kind === 'declined') {
    toast.error(structuredChatUnavailableText(support.reason))
    return null
  }
  if (support.kind !== 'admitted') {
    throw new Error('chat unavailable')
  }
  const permission = await readStructuredChatHostPermissionVerdict(target, agent)
  if (permission.kind !== 'allowed') {
    notifyHostPermissionRefused(agent, permission.kind)
    return null
  }
  return isCurrent() ? close : null
}
