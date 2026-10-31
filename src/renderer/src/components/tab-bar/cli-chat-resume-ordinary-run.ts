import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { conversationSwitchSourceKept } from '@/lib/conversation-switch-feedback'
import { useAppStore } from '@/store'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import { supportsStructuredAgentSessionCliSource } from '@/runtime/structured-agent-session-client'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { CLI_CONVERSATION_ADOPTING_AGENTS } from '../../../../shared/structured-agent-cli-conversation-adoption'
import { toHostSessionPaneKey } from '../../../../shared/terminal-surface-id'
import { resolveCliChatResumeSource, type CliChatResumeSource } from './cli-chat-resume-source'
import { reportCliChatResumeFailure } from './cli-chat-resume-ordinary-feedback'
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

export async function runOrdinaryCliChatResume(
  source: CliChatResumeSource,
  openOwner = false,
  selection?: {
    reportFailure?: (error: unknown) => void
    sourceCurrent: () => boolean
    afterTabId: string
  }
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
  const isCurrent = () => {
    if (controller.signal.aborted || (selection && !selection.sourceCurrent())) {
      return false
    }
    // The strict route already proved the captured process exited; idle is not loss of identity.
    if (selection) {
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
    const plan = adoptAgentSessionLaunchVerdict({
      route: 'structured-native-chat',
      requestId: newAgentLaunchRequestId(),
      agent,
      worktreeId: source.workspaceId,
      executionHostId: source.executionHostId,
      resumeFrom: {
        providerSessionId: source.providerSessionId,
        // The host matches its own pane keys, not this client's mirrored ones.
        ...(cliSourceSupported
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
      ...(selection ? { afterTabId: selection.afterTabId } : {})
    })
    if (!launch) {
      return
    }
    const result = await waitForPromiseWithSignal(launch.settlement, controller.signal)
    if (selection && result.kind === 'structured') {
      toast.info(conversationSwitchSourceKept(source.agent))
    }
    if (result.kind === 'failed' && !result.notified && pending.get(key) === controller) {
      await reportCliChatResumeFailure(
        source,
        result.error,
        openOwner,
        target,
        selection?.reportFailure
      )
    }
  } catch (error) {
    if (pending.get(key) === controller) {
      await reportCliChatResumeFailure(source, error, false, target, selection?.reportFailure)
    }
  } finally {
    clearTimeout(timer)
    stopSource()
    release()
  }
}
