import type { Tab } from '../../../../../shared/tab-types'
import { isAgentSessionConversationName } from '../../../../../shared/agent-session/agent-session-conversation-name'
import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '../session-ownership/structured-agent-session-owner'
import { getStructuredAgentSessionStatusFeed } from '../status/structured-agent-session-status-feed'
import { structuredChatShownName } from './structured-chat-shown-name'

type ChatTabNameSource = Pick<
  Tab,
  'entityId' | 'worktreeId' | 'executionHostId' | 'customLabel' | 'label'
>

/** A chat tab's name, read once outside React (labels built in plain functions): the same order
 *  the tab strip uses, from the host's feed as it stands now. Null while the chat has no name.
 *  Legacy tabs resolve their owner from the workspace just as the reactive tab reader does. */
export function resolveStructuredChatTabName(
  tab: ChatTabNameSource,
  state: AppState
): StructuredChatTabName {
  const owner = structuredAgentSessionOwnerForTab(state, tab)
  const target = structuredAgentSessionTargetForHost(owner)
  const name = target
    ? structuredChatShownName(getStructuredAgentSessionStatusFeed(target), tab.entityId)
    : undefined
  return {
    owner,
    sessionId: tab.entityId,
    savedName: tab.customLabel?.trim() || (isAgentSessionConversationName(name) ? name : null)
  }
}

export type StructuredChatTabName = Readonly<{
  owner: ExecutionHostId | null
  sessionId: string
  savedName: string | null
}>
export type StructuredChatTabNames = ReadonlyMap<Tab, StructuredChatTabName>

export function projectedStructuredChatTabSavedName(
  tab: Tab,
  names: StructuredChatTabNames
): string | null {
  return names.get(tab)?.savedName ?? (tab.customLabel?.trim() || null)
}
export function projectedStructuredChatTabName(tab: Tab, names: StructuredChatTabNames): string {
  return projectedStructuredChatTabSavedName(tab, names) ?? tab.label
}
export function readStructuredChatTabSavedName(
  tab: ChatTabNameSource,
  state: AppState
): string | null {
  return resolveStructuredChatTabName(tab, state).savedName
}

/** The chat tab's shown label: its name, else the tab's default label. */
export function readStructuredChatTabName(tab: ChatTabNameSource, state: AppState): string {
  return readStructuredChatTabSavedName(tab, state) ?? tab.label
}

/** Another chat's shown name and fork mark on this tab's host, read once (a fork tab's source,
 *  when its card opens): name null while unnamed; undefined when the host has said nothing of it. */
export function readStructuredChatSessionNamingOnTabHost(
  tab: ChatTabNameSource,
  sessionId: string,
  state: AppState
): { name: string | null; forked: boolean } | undefined {
  const target = structuredAgentSessionTargetForHost(structuredAgentSessionOwnerForTab(state, tab))
  const feed = target ? getStructuredAgentSessionStatusFeed(target) : null
  const note = feed?.getNamingSnapshot().get(sessionId)
  return feed && note
    ? { name: structuredChatShownName(feed, sessionId), forked: !!note.forkedFrom }
    : undefined
}
