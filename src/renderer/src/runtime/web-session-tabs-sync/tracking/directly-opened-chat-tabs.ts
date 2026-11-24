import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status/runtime-status-connection-generation'
import { getRuntimeEnvironmentRegistration } from '../../rpc/environment-revisions/runtime-environment-revision'
import { sessionTabsFreshnessKey, type MirroredAgentTab } from '../state'
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
  hostGroupIdByTabId: Map<string, string>
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
      : proof.previousEpoch !== undefined &&
        sameSessionTabsPublicationLineage(snapshot.publicationEpoch, proof.previousEpoch)
    if (
      earlier &&
      registration === proof.registration &&
      generation === proof.connectionGeneration &&
      isCurrentSessionTabsRuntimeFrame(environmentId, proof.runtimeId)
    ) {
      retained.set(tab.entityId, { hostTabId: proof.hostTabId, unifiedTab: tab })
      retainedProofs.set(tab.entityId, proof)
      if (proof.hostGroupId) {
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
