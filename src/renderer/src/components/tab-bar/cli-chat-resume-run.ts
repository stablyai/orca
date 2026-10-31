import { captureStructuredLaunchSurfaceAddress } from '@/lib/structured-agent-session-launch-surface'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { admitStructuredLaunchOnHost } from '@/lib/structured-agent-session-host-admission'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { holdEmptyWorkspaceDefaultSurfaceForLaunch } from '@/lib/empty-workspace-default-surface-claims'
import { closeCliChatResumeTerminal } from './cli-chat-resume-close-terminal'
import { toast } from 'sonner'
import { namesCliConversation } from '../../../../shared/structured-agent-cli-conversation-adoption'
import { cliConversationExitGuidance } from '@/lib/cli-conversation-exit-guidance'
import { structuredChatUnavailableText } from '@/lib/structured-agent-session-launch-failure'
import { STRUCTURED_AGENT_SESSION_CLOSE_TERMINAL_FOR_CHAT_RUNTIME_CAPABILITY } from '../../../../shared/structured-agent-session-surface-capabilities'
import { readStructuredChatHostPermissionVerdict } from '@/runtime/structured-chat-host-permission'
import { notifyHostPermissionRefused } from '@/lib/structured-agent-session-launch-permission-notice'
import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import {
  structuredAgentSessionHostSupports,
  supportsStructuredAgentSessionCliSource
} from '@/runtime/structured-agent-session-client'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { CLI_CONVERSATION_ADOPTING_AGENTS } from '../../../../shared/structured-agent-cli-conversation-adoption'
import { toHostSessionPaneKey } from '../../../../shared/terminal-surface-id'
import { resolveCliChatResumeSource, type CliChatResumeSource } from './cli-chat-resume-source'
import {
  reportCliChatResumeFailure,
  reportCliChatResumeOwner,
  reportCliChatResumeTerminalChanged
} from './cli-chat-resume-feedback'
import { adoptingAgentOnHost } from '../right-sidebar/ai-vault-session-resume-in-chat-launch'

const pending = new Map<string, AbortController>()
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((listener) => listener())
const keyFor = (source: CliChatResumeSource) =>
  [
    source.executionHostId,
    CLI_CONVERSATION_ADOPTING_AGENTS[source.agent],
    source.providerSessionId
  ].join('\0')
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCliChatResumePending(source: CliChatResumeSource | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !!source && pending.has(keyFor(source)),
    () => false
  )
}

export async function runCliChatResume(
  source: CliChatResumeSource,
  openOwner = false
): Promise<void> {
  const key = keyFor(source)
  if (pending.has(key) || source.hostUpdateRequired) {
    return
  }
  const target = structuredAgentSessionTargetForHost(source.executionHostId)
  if (!target) {
    return
  }
  const controller = new AbortController()
  let releaseHold: (() => void) | undefined
  let closing = false
  let closed = false
  const isCurrent = () => {
    if (controller.signal.aborted) {
      return false
    }
    if (closing) {
      return true
    }
    const current = resolveCliChatResumeSource(useAppStore.getState(), {
      tab: { id: source.tabId, worktreeId: source.workspaceId },
      paneKey: source.paneKey
    })
    return (
      !!current &&
      current.executionHostId === source.executionHostId &&
      current.providerSessionId === source.providerSessionId &&
      CLI_CONVERSATION_ADOPTING_AGENTS[current.agent] ===
        CLI_CONVERSATION_ADOPTING_AGENTS[source.agent]
    )
  }
  if (!isCurrent()) {
    return
  }
  const surfaceAddress = captureStructuredLaunchSurfaceAddress(source.workspaceId)
  const release = () => {
    if (pending.get(key) === controller) {
      pending.delete(key)
      changed()
    }
  }
  pending.set(key, controller)
  changed()
  const stopSource = useAppStore.subscribe(() => {
    if (!isCurrent()) {
      controller.abort()
      release()
    }
  })
  const timer = setTimeout(
    () => controller.abort(new Error('Conversation preparation timed out.')),
    30_000
  )
  let dispatched = false
  const handoff = () => {
    if (dispatched) {
      return true
    }
    if (!isCurrent()) {
      return false
    }
    dispatched = true
    stopSource()
    clearTimeout(timer)
    return true
  }
  try {
    const cliSourceSupported = await waitForPromiseWithSignal(
      supportsStructuredAgentSessionCliSource(target),
      controller.signal
    )
    if (!isCurrent()) {
      return
    }
    const agent = await waitForPromiseWithSignal(
      adoptingAgentOnHost(source.agent, source.workspaceId, source.executionHostId),
      controller.signal
    )
    if (!isCurrent()) {
      return
    }
    const closeSupported = await waitForPromiseWithSignal(
      structuredAgentSessionHostSupports(
        target,
        STRUCTURED_AGENT_SESSION_CLOSE_TERMINAL_FOR_CHAT_RUNTIME_CAPABILITY
      ),
      controller.signal
    )
    if (closeSupported) {
      const state = useAppStore.getState()
      // Chats and terminals that name this conversation on its host; the source tab's panes all close.
      const holders = Object.values(state.agentStatusByPaneKey).filter((row) => {
        const tabId = row.tabId ?? parsePaneKey(row.paneKey)?.tabId
        const workspaceId =
          row.worktreeId ??
          Object.entries(state.tabsByWorktree).find(([, tabs]) =>
            tabs.some((tab) => tab.id === tabId)
          )?.[0]
        return (
          tabId !== source.tabId &&
          !!workspaceId &&
          getExecutionHostIdForWorktree(state, workspaceId) === source.executionHostId &&
          namesCliConversation(row, agent, source.providerSessionId)
        )
      })
      const ownerRow = holders.find((row) => row.terminalResumeEligible === false)
      const ownerTab = ownerRow?.worktreeId
        ? state.unifiedTabsByWorktree[ownerRow.worktreeId]?.find((tab) => tab.id === ownerRow.tabId)
        : undefined
      if (ownerRow?.worktreeId && ownerTab) {
        await reportCliChatResumeOwner(
          { sessionId: ownerTab.entityId, workspaceId: ownerRow.worktreeId },
          openOwner,
          target
        )
        return
      }
      if (holders.some((row) => row.terminalResumeEligible !== false)) {
        toast.error(cliConversationExitGuidance(source.agent))
        return
      }
      const support = await waitForPromiseWithSignal(
        admitStructuredLaunchOnHost(target, toRuntimeWorktreeSelector(source.workspaceId), agent),
        controller.signal
      )
      if (!isCurrent()) {
        return
      }
      if (support.kind === 'declined') {
        toast.error(structuredChatUnavailableText(support.reason))
        return
      }
      if (support.kind !== 'admitted') {
        throw new Error('chat unavailable')
      }
      const permission = await readStructuredChatHostPermissionVerdict(target, agent)
      if (permission.kind !== 'allowed') {
        notifyHostPermissionRefused(agent, permission.kind)
        return
      }
      if (!isCurrent()) {
        return
      }
      closed = await closeCliChatResumeTerminal(
        source,
        isCurrent,
        {
          // The close's own confirmations and exit waits have their own bounds.
          prepared: () => clearTimeout(timer),
          closing: () => {
            closing = true
            stopSource()
            releaseHold = holdEmptyWorkspaceDefaultSurfaceForLaunch(source.workspaceId)
          },
          refused: () => reportCliChatResumeTerminalChanged(source)
        },
        controller.signal
      )
      if (!closed) {
        return
      }
    }
    const plan = adoptAgentSessionLaunchVerdict({
      route: 'structured-native-chat',
      requestId: newAgentLaunchRequestId(),
      agent,
      worktreeId: source.workspaceId,
      executionHostId: source.executionHostId,
      resumeFrom: {
        providerSessionId: source.providerSessionId,
        // The host matches its own pane keys, not this client's mirrored ones.
        ...(!closed && cliSourceSupported
          ? {
              cliSource: {
                workspaceId: source.workspaceId,
                paneKey: toHostSessionPaneKey(source.paneKey)
              }
            }
          : {})
      }
    })
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan,
      hooks: { beforeCreate: handoff },
      deferPublication: true,
      // Captured at the click: a closed source no longer marks where its chat goes.
      target: { surfaceAddress }
    })
    if (!launch) {
      return
    }
    const result = await waitForPromiseWithSignal(launch.settlement, controller.signal)
    if (result.kind === 'failed' && !result.notified && pending.get(key) === controller) {
      await reportCliChatResumeFailure(source, result.error, openOwner, target, closed, closing)
    }
  } catch (error) {
    if (pending.get(key) === controller) {
      await reportCliChatResumeFailure(source, error, false, target, closed, closing)
    }
  } finally {
    clearTimeout(timer)
    stopSource()
    releaseHold?.()
    release()
  }
}
