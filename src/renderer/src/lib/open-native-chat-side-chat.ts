import { agentChatPermissionModes } from '../../../shared/agent-chat-permission-mode'
import { structuredAgentSessionSendBody } from '../../../shared/structured-agent-session-send-mutation'
import type { AgentJournalSkillRef } from '../../../shared/agent-session-journal-types'
import { useAppStore } from '@/store'
import { newAgentLaunchRequestId } from './agent-launch-request-id'
import { adoptAgentSessionLaunchVerdict } from './agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from './agent-session/structured-agent-session-provisional-tab'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import type { SideChatPermission } from '../../../shared/agent-session-side-chat'
import {
  supportsStructuredAgentSessionSideChat,
  supportsStructuredAgentSessionReadOnlySideChat
} from '@/runtime/structured-agent-session-client'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import {
  captureWebSessionIntentOwner,
  matchesWebSessionIntentOwner
} from '@/runtime/web-runtime-session-environment'

type SideChatSource = { tabId: string; worktreeId: string; sessionId: string }
const pending = new Map<string, Promise<boolean>>()

function readSideChatSource(source: SideChatSource) {
  return useAppStore
    .getState()
    .unifiedTabsByWorktree[source.worktreeId]?.find(
      (tab) =>
        tab.id === source.tabId &&
        tab.contentType === 'agent-session' &&
        tab.entityId === source.sessionId
    )
}

/** Coalesce identical pending opens; later actions can still create independent side chats. */
export function openNativeChatSideChat(
  source: SideChatSource,
  question = '',
  skills: readonly AgentJournalSkillRef[] = [],
  permission: SideChatPermission = 'inherit'
): Promise<boolean> {
  skills = structuredAgentSessionSendBody(question, [], skills).skills ?? []
  const tab = readSideChatSource(source)
  const host = tab && structuredAgentSessionOwnerForTab(useAppStore.getState(), tab)
  const target = structuredAgentSessionTargetForHost(host)
  if (!host || !target) {
    return Promise.resolve(false)
  }
  const owner =
    target.kind === 'environment' ? captureWebSessionIntentOwner(target.environmentId) : null
  const key = JSON.stringify([
    host,
    owner?.pairingRevision,
    source.worktreeId,
    source.tabId,
    source.sessionId,
    question,
    skills,
    permission
  ])
  const existing = pending.get(key)
  if (existing) {
    return existing
  }
  const opening: Promise<boolean> = launchNativeChatSideChat(
    source,
    question,
    skills,
    permission,
    () => !owner || matchesWebSessionIntentOwner(owner)
  ).finally(() => {
    if (pending.get(key) === opening) {
      pending.delete(key)
    }
  })
  pending.set(key, opening)
  return opening
}

async function launchNativeChatSideChat(
  source: SideChatSource,
  question: string,
  skills: readonly AgentJournalSkillRef[],
  permission: SideChatPermission,
  isCurrentOwner: () => boolean
): Promise<boolean> {
  const readSource = () => readSideChatSource(source)
  const tab = readSource()
  const agent = tab?.agentSessionAgent
  if (!tab || !agent || !isTuiAgent(agent)) {
    return false
  }
  const host = structuredAgentSessionOwnerForTab(useAppStore.getState(), tab)
  const target = structuredAgentSessionTargetForHost(host)
  if (!host || !target || !(await supportsStructuredAgentSessionSideChat(target))) {
    return false
  }
  if (
    permission === 'read-only' &&
    (!agentChatPermissionModes(agent)?.modes.includes('read-only') ||
      !(await supportsStructuredAgentSessionReadOnlySideChat(target)))
  ) {
    return false
  }
  const isCurrent = () => {
    const current = readSource()
    return (
      isCurrentOwner() &&
      !!current &&
      current.agentSessionAgent === agent &&
      structuredAgentSessionOwnerForTab(useAppStore.getState(), current) === host
    )
  }
  if (!isCurrent()) {
    return false
  }
  const plan = adoptAgentSessionLaunchVerdict({
    route: 'structured-native-chat',
    requestedSurface: 'chat',
    requestId: newAgentLaunchRequestId(),
    worktreeId: source.worktreeId,
    executionHostId: host,
    agent,
    sideChatOf: source.sessionId,
    ...(permission === 'read-only' ? { launchOptions: { permissionMode: 'read-only' } } : {}),
    ...(question.trim()
      ? {
          prompt: question,
          promptDelivery: 'auto-submit',
          ...(skills.length > 0 ? { skills } : {})
        }
      : {})
  })
  const launch = beginStructuredAgentSessionProvisionalLaunch({
    plan,
    hooks: { beforeCreate: isCurrent },
    afterTabId: source.tabId,
    beforeOpen: isCurrent
  })
  if (!launch) {
    return false
  }
  const result = await launch.settlement
  if (result.kind !== 'structured') {
    return false
  }
  return result.promptDeliveryResult ? (await result.promptDeliveryResult).delivered : true
}
