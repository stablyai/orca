import { readRuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { captureStructuredLaunchSurfaceAddress } from '@/lib/agent-session/launch/structured-agent-session-launch-surface'
import {
  captureCliChatResumeSurfaces,
  cliChatResumeClosingPaneKeys,
  closeCliChatResumeTerminal
} from './cli-chat-resume-close-terminal'
import {
  admitCliChatResumeClose,
  showCliChatResumeLaunchHolder,
  withoutJoiningLaunchHolder,
  type LaunchHeld
} from './cli-chat-resume-close-admission'
import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store/index'

import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import { supportsStructuredAgentSessionCliSource } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-support'
import { structuredAgentSessionTargetForHost } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { waitForPromiseWithSignal } from '../../../../../shared/concurrency/abort-signal-reason'
import { CLI_CONVERSATION_ADOPTING_AGENTS } from '../../../../../shared/agent-session/view/structured-agent-cli-conversation-adoption'
import { toHostSessionPaneKey } from '../../../../../shared/workspace-layout/terminal-surface-id'
import { resolveCliChatResumeSource, type CliChatResumeSource } from './cli-chat-resume-source'
import {
  reopenMissingForkConversation,
  reportCliChatResumeFailure,
  reportCliChatResumeTerminalChanged
} from './cli-chat-resume-feedback'
import { adoptingAgentOnHost } from '../../right-sidebar/ai-vault/session-actions/ai-vault-session-resume-in-chat-launch'

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
  const isCurrent = () => {
    if (controller.signal.aborted) {
      return false
    }
    if (closing) {
      return true
    }
    const current = resolveCliChatResumeSource(useAppStore.getState(), readRuntimeStatuses(), {
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
  const sourceGroup = useAppStore
    .getState()
    .groupsByWorktree[source.workspaceId]?.find((group) => group.tabOrder.includes(source.tabId))
  const sourceIndex = sourceGroup ? sourceGroup.tabOrder.indexOf(source.tabId) : -1
  const afterTabSurfaceAddress =
    sourceGroup && sourceIndex !== -1
      ? {
          worktreeId: source.workspaceId,
          targetGroupId: sourceGroup.id,
          precedingTabIds: sourceGroup.tabOrder.slice(0, sourceIndex + 1)
        }
      : surfaceAddress
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
    const closingPaneKeys = closes
      ? cliChatResumeClosingPaneKeys(useAppStore.getState(), source)
      : undefined
    const verdict = adoptAgentSessionLaunchVerdict({
      route: 'structured-native-chat',
      requestId: createNonSecureContextUuid(),
      agent,
      worktreeId: source.workspaceId,
      executionHostId: source.executionHostId,
      resumeFrom: {
        providerSessionId: source.providerSessionId,
        ...(closingPaneKeys?.length ? { closingPaneKeys } : {}),
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
    const sourceSurfaces = captureCliChatResumeSurfaces(useAppStore.getState(), source)
    const held: LaunchHeld = {}
    const plan = closes ? withoutJoiningLaunchHolder(verdict, source, agent, held) : verdict
    // Open and commit the chat before touching the terminal so any create failure leaves the terminal alive.
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan,
      hooks: { beforeCreate: handoff },
      deferPublication: true,
      target: { surfaceAddress: closes ? afterTabSurfaceAddress : surfaceAddress },
      ...(closes ? { resumeWritersChecked: true as const } : {})
    })
    const result = launch
      ? await waitForPromiseWithSignal(launch.settlement, controller.signal)
      : null
    if (held.holder) {
      await showCliChatResumeLaunchHolder(held.holder, openOwner, target)
      return
    }
    if (!result) {
      return
    }
    const closeSourceTerminal = async (): Promise<void> => {
      if (!closes || !isCurrent()) {
        return
      }
      try {
        await closeCliChatResumeTerminal(
          source,
          sourceSurfaces,
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
              if (!superseded) {
                reportCliChatResumeTerminalChanged(source)
              }
            }
          },
          controller.signal,
          close === 'close'
        )
      } catch (error) {
        console.warn('[cli-chat-resume] closing source terminal after chat opened failed', error)
      }
    }
    if (result.kind === 'structured') {
      await closeSourceTerminal()
      return
    }
    if (result.kind !== 'failed') {
      return
    }
    if (closes && (await reopenMissingForkConversation(result.error, source, target))) {
      await closeSourceTerminal()
      return
    }
    if (!result.notified && pending.get(key)?.controller === controller) {
      await reportCliChatResumeFailure(source, result.error, openOwner, target)
    }
  } catch (error) {
    if (pending.get(key)?.controller === controller) {
      await reportCliChatResumeFailure(source, error, false, target, closing)
    }
  } finally {
    clearTimeout(timer)
    stopSource()
    release()
  }
}
