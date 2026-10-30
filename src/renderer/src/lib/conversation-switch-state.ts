import { resolveWorktreeExecutionHostPlatform } from './execution-host-facts'
import { translate } from '@/i18n/i18n'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { findStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner-registry'
import { runningStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import { useInPlaceSwitchCapability } from './in-place-switch-support'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { refreshLocalStructuredSessionWorktreeTabs } from '@/runtime/local-structured-session-tabs-sync/inventory-refresh'
import {
  pendingNativeChatCliSwitches as pending,
  pendingCliChatResumes,
  subscribeConversationSwitch as subscribe
} from './pending-conversation-surface-switches'
import type { AiVaultSession, AiVaultAgent } from '../../../shared/ai-vault-types'
import type { CliChatResumeSource } from '@/components/tab-bar/cli-chat-resume-source'

export type ConversationSwitch = {
  legacyContinue?: () => Promise<void>
  confirm?: ConfirmationDialogContextValue
  direction: 'chat' | 'terminal'
  executionHostId: string
  workspaceId: string
  agent: AiVaultAgent
  sessionId?: string
  chatTabId?: string | null
  source?: CliChatResumeSource
  history?: AiVaultSession
  platform?: string
  feedback?: (message: string, kind: 'error' | 'info') => void
}

export function withConversationSwitchPlatform(args: ConversationSwitch): ConversationSwitch {
  const platform = resolveWorktreeExecutionHostPlatform(
    useAppStore.getState(),
    args.workspaceId,
    undefined
  )
  return {
    ...args,
    platform: args.platform ?? (platform.kind === 'known' ? platform.platform : undefined)
  }
}

export const keyFor = (args: ConversationSwitch) =>
  `${args.executionHostId}\0${args.sessionId ?? args.source?.providerSessionId ?? args.history?.sessionId}`

export function pendingNow(args: ConversationSwitch) {
  return (
    pending.has(keyFor(args)) ||
    Boolean(args.sessionId && pending.has(`${args.executionHostId}\0${args.sessionId}`)) ||
    [...pendingCliChatResumes.values()].some(
      ({ source }) =>
        source.executionHostId === args.executionHostId &&
        source.providerSessionId === args.source?.providerSessionId
    )
  )
}

export function useConversationSwitchPending(args: ConversationSwitch | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => Boolean(args && pendingNow(args)),
    () => false
  )
}

/** Controls bind disabled at once; the visible working state waits so a fast local switch stays clean. */
export function useConversationSwitchBusy(pending: boolean, delayMs = 200): boolean {
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!pending) {
      setBusy(false)
      return
    }
    const timer = setTimeout(() => setBusy(true), delayMs)
    return () => clearTimeout(timer)
  }, [pending, delayMs])
  return pending && busy
}

/** Live facts choose consent only; never open a reader to classify saved work. */
export function conversationSwitchReplying(args: ConversationSwitch): boolean {
  const state = useAppStore.getState()
  if (args.source) {
    return state.agentStatusByPaneKey[args.source.paneKey]?.state === 'working'
  }
  const target = structuredAgentSessionTargetForHost(args.executionHostId)
  if (!args.sessionId || !target) {
    return false
  }
  const held = findStructuredAgentSessionReadOwner(args.sessionId, target)?.getSnapshot()
  return Boolean(
    (held?.current &&
      held.state.working !== false &&
      runningStructuredAgentSessionTurnId(held.state)) ||
    getStructuredAgentSessionStatusFeed(target).getSnapshot().get(args.sessionId)?.status ===
      'working'
  )
}

export function useConversationSwitchReadiness(args: ConversationSwitch | null) {
  const capability = useInPlaceSwitchCapability(args?.executionHostId, args?.agent)
  const pending = useConversationSwitchPending(args)
  const updateRequired = args?.source?.hostUpdateRequired === true
  return {
    ready: Boolean(
      args &&
      structuredAgentSessionTargetForHost(args.executionHostId) &&
      capability !== undefined &&
      !pending &&
      !updateRequired
    ),
    pending,
    explanation: updateRequired
      ? translate(
          'components.native-chat.resumeInNewChat.hostUpdateRequired',
          'Update Orca on this host to continue in Chat UI.'
        )
      : undefined
  }
}

export function rederiveConversationSwitch(args: ConversationSwitch): void {
  const target = structuredAgentSessionTargetForHost(args.executionHostId)
  if (!target) {
    return
  }
  if (args.sessionId) {
    findStructuredAgentSessionReadOwner(args.sessionId, target)?.resync?.()
  }
  const refresh =
    target.kind === 'local'
      ? refreshLocalStructuredSessionWorktreeTabs(args.workspaceId, {
          reacceptCurrentVersion: true
        })
      : import('@/runtime/web-runtime-session-snapshot').then(
          ({ refreshWebRuntimeSessionTabsSnapshot }) =>
            refreshWebRuntimeSessionTabsSnapshot(target.environmentId, args.workspaceId, {
              acceptCurrentSnapshot: true,
              afterCurrentInFlight: true
            })
        )
  void refresh.catch(() => {})
}
