import { runOrdinaryCliChatResume } from './cli-chat-resume-ordinary-run'
import {
  captureTerminalSurfaceIdentity,
  isRetainedTerminalSurfaceIdentity
} from '../../../../shared/terminal-tab-close'
import { toast } from 'sonner'
import { conversationSwitchFailureText } from '@/lib/conversation-switch-feedback'
import {
  conversationSwitchChanged,
  isCliChatResumePending,
  pendingCliChatResumes as pending
} from '@/lib/pending-conversation-surface-switches'
import { useAppStore } from '@/store'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { resolveCliChatResumeSource, type CliChatResumeSource } from './cli-chat-resume-source'
import { adoptingAgentOnHost } from '../right-sidebar/ai-vault-session-resume-in-chat-launch'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { captureSourceTerminal } from './cli-chat-resume-terminal-capture'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'

/** Old peers stop the addressed PTY before ordinary adoption; a kill acknowledgement is never exit proof. */
export async function runLegacyCliChatResume(
  source: CliChatResumeSource,
  reportFailure?: (error: unknown) => void
): Promise<void> {
  const key = `${source.executionHostId}\0${source.agent}\0${source.providerSessionId}`
  const target = structuredAgentSessionTargetForHost(source.executionHostId)
  if (!target || source.hostUpdateRequired || isCliChatResumePending(key)) {
    return
  }
  const leafId = source.paneKey.slice(source.tabId.length + 1)
  const rendererIdentity = captureTerminalSurfaceIdentity(
    useAppStore.getState(),
    source.workspaceId,
    source.tabId,
    leafId
  )
  const stillCaptured = () => {
    const current = captureTerminalSurfaceIdentity(
      useAppStore.getState(),
      source.workspaceId,
      source.tabId,
      leafId
    )
    return (
      rendererIdentity !== null &&
      current !== null &&
      isRetainedTerminalSurfaceIdentity(rendererIdentity, current)
    )
  }
  const controller = new AbortController()
  const isCurrent = () => {
    const current = resolveCliChatResumeSource(useAppStore.getState(), {
      tab: { id: source.tabId, worktreeId: source.workspaceId },
      paneKey: source.paneKey
    })
    return (
      current?.ptyId === source.ptyId &&
      current?.executionHostId === source.executionHostId &&
      current?.providerSessionId === source.providerSessionId &&
      current?.agent === source.agent
    )
  }
  pending.set(controller, { key, source })
  conversationSwitchChanged()
  try {
    const captured = await captureSourceTerminal(source)
    // A pane with no terminal to capture has no process to stop: the earlier resume opens the
    // conversation as a chat beside it.
    if (!captured) {
      await runOrdinaryCliChatResume(source, true)
      return
    }
    const ptyId = captured.presentation?.identity.ptyId
    if (!ptyId || !isCurrent()) {
      throw stopUnknown()
    }
    if (!stillCaptured()) {
      return
    }
    await adoptingAgentOnHost(source.agent, source.workspaceId, source.executionHostId)
    if (!isCurrent() || !stillCaptured()) {
      return
    }
    const stopped = await callRuntimeRpc<{
      stoppedPtyIds?: string[]
      postStopVerified?: boolean
      remainingLivePtyIds?: string[]
    }>(captured.target, 'terminal.stopExact', {
      worktree: `id:${source.workspaceId}`,
      expectedPtyIds: [ptyId],
      targetOnly: true,
      keepHistory: true
    }).catch(() => {
      throw stopUnknown()
    })
    if (
      !stopped ||
      stopped.postStopVerified !== true ||
      !Array.isArray(stopped.stoppedPtyIds) ||
      stopped.stoppedPtyIds.length !== 1 ||
      stopped.stoppedPtyIds[0] !== ptyId ||
      (stopped.remainingLivePtyIds !== undefined &&
        (!Array.isArray(stopped.remainingLivePtyIds) ||
          stopped.remainingLivePtyIds.includes(ptyId)))
    ) {
      throw stopUnknown()
    }
    const current = resolveCliChatResumeSource(useAppStore.getState(), {
      tab: { id: source.tabId, worktreeId: source.workspaceId },
      paneKey: source.paneKey
    })
    if (current && !isCurrent()) {
      return
    }
    if (!stillCaptured()) {
      return
    }
    await runOrdinaryCliChatResume(source, true, {
      reportFailure,
      sourceCurrent: stillCaptured,
      afterTabId: source.tabId
    })
  } catch (error) {
    // A stopped shell can cease being busy or disappear; that never turns proven Stop into a failure.
    if (reportFailure) {
      reportFailure(error)
    } else {
      toast.error(
        conversationSwitchFailureText(error, { agent: source.agent, direction: 'chat', source })
      )
    }
  } finally {
    pending.delete(controller)
    conversationSwitchChanged()
  }
}

function stopUnknown() {
  return agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'ownerUnproven' })
}
