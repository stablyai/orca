import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import {
  supportsInPlaceSwitch,
  supportsStructuredAgentSessionCliSource
} from '@/runtime/structured-agent-session-client'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { CLI_CONVERSATION_ADOPTING_AGENTS } from '../../../../shared/structured-agent-cli-conversation-adoption'
import { resolveCliChatResumeSource, type CliChatResumeSource } from './cli-chat-resume-source'
import {
  reportCliChatResumeFailure,
  startCliChatReturn,
  toastCliChatResumeFailure
} from './cli-chat-resume-feedback'
import { adoptingAgentOnHost } from '../right-sidebar/ai-vault-session-resume-in-chat-launch'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { captureSourceTerminal } from './cli-chat-resume-terminal-capture'
import {
  isCliChatResumePending,
  pendingCliChatResumes as pending
} from '@/lib/pending-conversation-surface-switches'

/** The execution host closes only the captured shell; refused or unknown closes leave it alone. */
async function retireSwitchedTerminalPane(
  expected: ReturnType<typeof captureSourceTerminal>
): Promise<void> {
  const captured = await expected
  if (!captured?.presentation) {
    throw new Error('terminal_close_unverifiable')
  }
  await callRuntimeRpc(captured.target, 'terminal.close', {
    terminal: captured.handle,
    expectedIncarnationId: captured.incarnationId,
    originalPresentation: captured.presentation
  })
}

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
    () => !!source && isCliChatResumePending(keyFor(source)),
    () => false
  )
}

/** Switches a terminal's conversation into a chat in the terminal's slot: a new chat, or the chat
 *  that already holds it, revealed. The terminal pane closes once the chat has it. */
export async function runCliChatResume(source: CliChatResumeSource): Promise<void> {
  const key = keyFor(source)
  if (isCliChatResumePending(key)) {
    return
  }
  const target = structuredAgentSessionTargetForHost(source.executionHostId)
  if (!target) {
    return
  }
  const controller = new AbortController()
  const isCurrent = () => {
    if (controller.signal.aborted) {
      return false
    }
    const current = resolveCliChatResumeSource(useAppStore.getState(), {
      tab: { id: source.tabId, worktreeId: source.workspaceId },
      paneKey: source.paneKey
    })
    return (
      !!current &&
      current.ptyId === source.ptyId &&
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
    const operation = pending.get(controller)
    if (operation?.key === key) {
      operation.key = null
      changed()
    }
  }
  pending.set(controller, { key, source })
  let stopSource = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
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
  let inPlace = false
  try {
    changed()
    const sourceIncarnation = captureSourceTerminal(source)
    stopSource = useAppStore.subscribe(() => {
      if (!isCurrent()) {
        controller.abort()
        release()
      }
    })
    timer = setTimeout(
      () => controller.abort(new Error('Conversation preparation timed out.')),
      30_000
    )
    let retireSource = false
    try {
      await waitForPromiseWithSignal(sourceIncarnation, controller.signal)
      if (!isCurrent()) {
        return
      }
      inPlace = await waitForPromiseWithSignal(
        supportsInPlaceSwitch(target, source.agent),
        controller.signal
      )
      if (target.kind !== 'local' && !inPlace) {
        return
      }
      const cliSourceSupported = await waitForPromiseWithSignal(
        supportsStructuredAgentSessionCliSource(target),
        controller.signal
      )
      if (!isCurrent()) {
        return
      }
      const agent = await waitForPromiseWithSignal(
        adoptingAgentOnHost(source.agent, source.workspaceId),
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
          ...(cliSourceSupported
            ? { cliSource: { workspaceId: source.workspaceId, paneKey: source.paneKey } }
            : {})
        }
      })
      const state = useAppStore.getState()
      const group = state.groupsByWorktree[source.workspaceId]?.find((g) =>
        g.tabOrder.includes(source.tabId)
      )
      const launch = beginStructuredAgentSessionProvisionalLaunch({
        plan,
        hooks: { beforeCreate: handoff },
        afterTabId: source.tabId,
        target: group
          ? {
              surfaceAddress: {
                worktreeId: source.workspaceId,
                targetGroupId: group.id,
                precedingTabIds: group.tabOrder.slice(0, group.tabOrder.indexOf(source.tabId) + 1)
              }
            }
          : undefined,
        deferPublication: true
      })
      if (!launch) {
        return
      }
      const result = await waitForPromiseWithSignal(launch.settlement, controller.signal)
      if (result.kind === 'structured' && inPlace) {
        retireSource = await startCliChatReturn(source, result.sessionId, target)
      } else if (
        result.kind === 'failed' &&
        !result.notified &&
        pending.get(controller)?.key === key &&
        (await reportCliChatResumeFailure(source, result.error, target))
      ) {
        retireSource = inPlace
      }
    } catch (error) {
      if (
        pending.get(controller)?.key === key &&
        (await reportCliChatResumeFailure(source, error, target))
      ) {
        retireSource = inPlace
      }
    }
    if (retireSource) {
      try {
        await retireSwitchedTerminalPane(sourceIncarnation)
      } catch (error) {
        toastCliChatResumeFailure(source, error)
      }
    }
  } finally {
    clearTimeout(timer)
    stopSource()
    try {
      release()
    } finally {
      pending.delete(controller)
      useAppStore.setState((state) => ({
        agentConversationsByPaneKey: state.agentConversationsByPaneKey
      }))
    }
  }
}
