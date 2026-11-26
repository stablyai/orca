import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { hostSnapshotAffirmsAgentSessions } from '../../../../../shared/remote-runtime/session-graph/host-session-snapshot-authority'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status/runtime-status-connection-generation'
import { getRuntimeEnvironmentRegistration } from '../../rpc/environment-revisions/runtime-environment-revision'
import {
  sessionTabsFreshnessKey,
  type MirroredAgentTab,
  type WebSessionTabsSyncState
} from '../state'
import { isWebSessionTabsWorktreeRemovalFrame } from './session-tabs-inventory-absence'
import {
  isCurrentSessionTabsRuntimeFrame,
  sameSessionTabsPublicationLineage
} from './publisher-identity-fences'

type ChatPublication = {
  tabId: string
  hostTabId: string
  hostGroupId?: string
  registration: ReturnType<typeof getRuntimeEnvironmentRegistration>
  connectionGeneration: number
  runtimeId?: string
  receivedFrame: number
  publicationEpoch: string
  snapshotVersion: number
  previousEpoch?: string
  initialGroupId?: string
}

// A proof lives with its tab until a current frame, close or workspace teardown retires it.
const directlyOpenedChats = new Map<string, Map<string, ChatPublication>>()

export function directlyOpenedChatPublications(
  environmentId: string,
  worktreeId: string
): ReadonlyMap<string, ChatPublication> | undefined {
  return directlyOpenedChats.get(sessionTabsFreshnessKey(environmentId, worktreeId))
}

export function canAdoptInitialHostGroups(
  state: WebSessionTabsSyncState,
  worktreeId: string,
  executionHostId: ExecutionHostId,
  receivedChats: ReadonlyMap<string, ChatPublication> | undefined
): boolean {
  const groups = state.groupsByWorktree[worktreeId]
  const layout = state.layoutByWorktree[worktreeId]
  const group = groups?.[0]
  return Boolean(
    receivedChats &&
    groups?.length === 1 &&
    group &&
    layout?.type === 'leaf' &&
    layout.groupId === group.id &&
    group.tabOrder.length === receivedChats.size &&
    [...receivedChats.values()].some((chat) => chat.initialGroupId === group.id) &&
    (state.unifiedTabsByWorktree[worktreeId] ?? []).every(
      (tab) =>
        tab.executionHostId === executionHostId && receivedChats.get(tab.entityId)?.tabId === tab.id
    )
  )
}

export function forgetDirectlyOpenedChat(
  environmentId: string,
  worktreeId: string,
  sessionId: string,
  tabId?: string
): void {
  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  const entries = directlyOpenedChats.get(key)
  if (!entries || (tabId !== undefined && entries.get(sessionId)?.tabId !== tabId)) {
    return
  }
  if (entries.delete(sessionId) && entries.size === 0) {
    directlyOpenedChats.delete(key)
  }
}

export function clearDirectlyOpenedChats(matches: (key: string) => boolean): void {
  for (const key of directlyOpenedChats.keys()) {
    if (matches(key)) {
      directlyOpenedChats.delete(key)
    }
  }
}

export function clearDirectlyOpenedChatsForWorktree(
  environmentId: string,
  worktreeId: string
): void {
  directlyOpenedChats.delete(sessionTabsFreshnessKey(environmentId, worktreeId))
}

export function recordDirectlyOpenedChat(
  environmentId: string,
  worktreeId: string,
  sessionId: string,
  publication: ChatPublication
): void {
  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  const entries = directlyOpenedChats.get(key) ?? new Map<string, ChatPublication>()
  entries.set(sessionId, publication)
  directlyOpenedChats.set(key, entries)
}

/** An older full frame can update other surfaces while the directly opened chat awaits its own frame. */
export function retainDirectlyOpenedChats(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  currentTabs: readonly Tab[],
  hostGroupIdByTabId: Map<string, string>,
  requestReceivedFrame?: number
): ReadonlyMap<string, MirroredAgentTab> | undefined {
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  const entries = directlyOpenedChats.get(key)
  if (!entries) {
    return
  }
  if (isWebSessionTabsWorktreeRemovalFrame(snapshot)) {
    directlyOpenedChats.delete(key)
    return
  }
  const registration = getRuntimeEnvironmentRegistration(environmentId)
  const generation = getRuntimeEnvironmentConnectionGeneration(environmentId)
  const host = toRuntimeExecutionHostId(environmentId)
  const affirmsAgentSessions = hostSnapshotAffirmsAgentSessions(snapshot)
  const retained = new Map<string, MirroredAgentTab>()
  const retainedProofs = new Map<string, ChatPublication>()
  for (const tab of currentTabs) {
    const proof = entries.get(tab.entityId)
    if (
      tab.contentType !== 'agent-session' ||
      tab.executionHostId !== host ||
      !proof ||
      tab.id !== proof.tabId
    ) {
      continue
    }
    const earlier = sameSessionTabsPublicationLineage(
      snapshot.publicationEpoch,
      proof.publicationEpoch
    )
      ? snapshot.snapshotVersion < proof.snapshotVersion
      : (requestReceivedFrame !== undefined && requestReceivedFrame < proof.receivedFrame) ||
        (proof.previousEpoch !== undefined &&
          sameSessionTabsPublicationLineage(snapshot.publicationEpoch, proof.previousEpoch))
    if (
      (earlier || !affirmsAgentSessions) &&
      registration === proof.registration &&
      generation === proof.connectionGeneration &&
      isCurrentSessionTabsRuntimeFrame(environmentId, proof.runtimeId)
    ) {
      retained.set(tab.entityId, { hostTabId: proof.hostTabId, unifiedTab: tab })
      retainedProofs.set(tab.entityId, proof)
      if (proof.hostGroupId && !hostGroupIdByTabId.has(proof.hostTabId)) {
        hostGroupIdByTabId.set(proof.hostTabId, proof.hostGroupId)
      }
    }
  }
  if (retainedProofs.size === 0) {
    directlyOpenedChats.delete(key)
  } else if (retainedProofs.size !== entries.size) {
    directlyOpenedChats.set(key, retainedProofs)
  }
  return retained.size > 0 ? retained : undefined
}
