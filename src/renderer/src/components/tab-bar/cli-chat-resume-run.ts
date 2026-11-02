import { captureStructuredLaunchSurfaceAddress } from '@/lib/agent-session/launch/structured-agent-session-launch-surface'
import { closeCliChatResumeTerminal } from './cli-chat-resume-close-terminal'
import { admitCliChatResumeClose } from './cli-chat-resume-close-admission'
import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import {
  adoptAgentSessionLaunchVerdict,
  type AgentSessionLaunchPlan
} from '@/lib/agent-session-launch-plan'
import {
  StructuredAgentSessionCreateSourceFailedError,
  type StructuredAgentSessionCreateGate
} from '@/lib/agent-session/launch/structured-agent-session-launch-errors'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import { supportsStructuredAgentSessionCliSource } from '@/runtime/structured-agent-session-client'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { CLI_CONVERSATION_ADOPTING_AGENTS } from '../../../../shared/structured-agent-cli-conversation-adoption'
import { toHostSessionPaneKey } from '../../../../shared/terminal-surface-id'
import { resolveCliChatResumeSource, type CliChatResumeSource } from './cli-chat-resume-source'
import {
  cliChatResumeExitUnprovenText,
  reportCliChatResumeFailure,
  reportCliChatResumeFailureInChat,
  reportCliChatResumeTerminalChanged
} from './cli-chat-resume-feedback'
import { adoptingAgentOnHost } from '../right-sidebar/ai-vault-session-resume-in-chat-launch'

const pending = new Map<string, { controller: AbortController; source: CliChatResumeSource }>()
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
  let closing = false
  let closed = false
  // The chat that replaces a closing terminal opens first; closing it before the terminal goes cancels.
  let chatTabId: string | null = null
  let finished = false
  const dropChat = () => {
    const tabId = chatTabId
    // Cleared first: a chat this run closes is not the user cancelling.
    chatTabId = null
    if (tabId) {
      useAppStore.getState().closeUnifiedTab(tabId)
    }
  }
  const chatClosed = () =>
    !!chatTabId &&
    !(useAppStore.getState().unifiedTabsByWorktree[source.workspaceId] ?? []).some(
      (tab) => tab.id === chatTabId
    )
  const isCurrent = () => {
    if (controller.signal.aborted) {
      return false
    }
    if (closing) {
      return true
    }
    if (chatClosed()) {
      return false
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
    if (pending.get(key)?.controller === controller) {
      pending.delete(key)
      changed()
    }
  }
  pending.set(key, { controller, source })
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
  // The chat's create waits for the terminal's proven exit; false abandons it, a refusal fails it.
  let releaseCreate: ((go: StructuredAgentSessionCreateGate) => void) | undefined
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
    const close = await admitCliChatResumeClose(
      source,
      agent,
      target,
      openOwner,
      isCurrent,
      controller.signal
    )
    if (close === null) {
      return
    }
    const closes = close !== 'keep'
    const verdict = adoptAgentSessionLaunchVerdict({
      route: 'structured-native-chat',
      requestId: newAgentLaunchRequestId(),
      agent,
      worktreeId: source.workspaceId,
      executionHostId: source.executionHostId,
      resumeFrom: {
        providerSessionId: source.providerSessionId,
        // The host matches its own pane keys, not this client's mirrored ones.
        ...(!closes && cliSourceSupported
          ? {
              cliSource: {
                workspaceId: source.workspaceId,
                paneKey: toHostSessionPaneKey(source.paneKey)
              }
            }
          : {})
      }
    })
    // A chat already opening this conversation is joined: its create isn't this terminal's to gate.
    let joinedOther = false
    const plan: AgentSessionLaunchPlan = closes
      ? {
          ...verdict,
          begin: (hooks, launchTarget) => {
            const handle = verdict.begin(hooks, launchTarget)
            joinedOther = handle?.joined === true
            return handle
          }
        }
      : verdict
    let tabOpened: ((tabId: string | null) => void) | undefined
    const chatOpened = new Promise<string | null>((resolve) => {
      tabOpened = resolve
    })
    const launch = beginStructuredAgentSessionProvisionalLaunch(
      closes
        ? {
            plan,
            hooks: {
              beforeCreate: handoff,
              createAfter: new Promise<StructuredAgentSessionCreateGate>((resolve) => {
                releaseCreate = resolve
              })
            },
            // The chat takes the terminal's place, shown before the terminal goes.
            afterTabId: source.tabId,
            onTabOpenSettled: (tabId) => {
              if (finished && tabId && !closed && !joinedOther) {
                // Its create was abandoned when the run ended without closing the terminal.
                useAppStore.getState().closeUnifiedTab(tabId)
                return
              }
              tabOpened?.(tabId)
            }
          }
        : {
            plan,
            hooks: { beforeCreate: handoff },
            deferPublication: true,
            // Captured at the click: the terminal stays, but its tab may move before the chat opens.
            target: { surfaceAddress }
          }
    )
    if (!launch) {
      return
    }
    if (closes) {
      const opened = await waitForPromiseWithSignal(chatOpened, controller.signal)
      // The joined chat shows, as an owner chat does, and the terminal stays beside it.
      if (joinedOther) {
        return
      }
      chatTabId = opened
    }
    if (chatTabId) {
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
          },
          refused: () => {
            // A newer continuation of this terminal tab answers the merged confirmation itself.
            const superseded =
              controller.signal.aborted &&
              [...pending.values()].some(
                (other) =>
                  other.controller !== controller &&
                  other.source.tabId === source.tabId &&
                  other.source.executionHostId === source.executionHostId
              )
            if (!superseded && !chatClosed()) {
              reportCliChatResumeTerminalChanged(source)
            }
          }
        },
        controller.signal,
        close === 'close'
      )
      if (!closed) {
        return
      }
      releaseCreate?.(true)
    }
    // A chat that ended before its tab opened has no terminal to close; its failure is said here.
    const result = await waitForPromiseWithSignal(launch.settlement, controller.signal)
    if (result.kind !== 'failed' || chatClosed()) {
      return
    }
    if (closed) {
      await reportCliChatResumeFailureInChat(result.error, openOwner, target, dropChat)
      return
    }
    if (!result.notified && pending.get(key)?.controller === controller) {
      await reportCliChatResumeFailure(source, result.error, openOwner, target)
    }
  } catch (error) {
    if (closing && chatTabId && !chatClosed()) {
      // The terminal is gone, so the chat that took its place says why, without a toast on top.
      releaseCreate?.(
        new StructuredAgentSessionCreateSourceFailedError(cliChatResumeExitUnprovenText(source))
      )
    } else if (pending.get(key)?.controller === controller) {
      await reportCliChatResumeFailure(source, error, false, target, closing)
    }
  } finally {
    finished = true
    clearTimeout(timer)
    stopSource()
    if (releaseCreate && !closed) {
      // Before the close the terminal stayed, so its replacement goes with nothing created.
      releaseCreate(false)
      if (!closing && !chatClosed()) {
        dropChat()
      }
    }
    release()
  }
}
