import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  markStructuredAgentSessionLaunchesPublished,
  publishedStructuredSessions
} from '@/lib/structured-agent-session-launch-publication'
import {
  hasStructuredAgentSessionLaunchCancellationTombstone,
  markStructuredAgentSessionLaunchCancelled
} from '@/lib/structured-agent-session-launch-registry'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { discardStructuredAgentSessionChatSends } from '@/lib/structured-agent-session-launch-prompt'
import { stopStructuredAgentSessionSends } from '@/components/native-chat/structured-agent-session-message-sender'
import { retireStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner-registry'
import { closeStructuredAgentSession } from './structured-agent-session-close'
import {
  isLocalSessionTabCloseOwned,
  withLocalSessionTabCloseOwner
} from './local-session-tab-close-owner'
import { executionHostIdForStructuredTarget } from './structured-agent-session-owner'
import { callRuntimeRpc, type RuntimeClientTarget } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

const inFlightRetirements = new Map<string, Promise<void>>()

function structuredAgentSessionHostTabId(sessionId: string): string {
  return `agent-session:${sessionId}`
}

function retirementKey(target: RuntimeClientTarget, worktreeId: string, sessionId: string): string {
  return `${target.kind}:${target.kind === 'environment' ? target.environmentId : 'local'}:${worktreeId}:${sessionId}`
}

/** Best-effort host cleanup; local removal must never wait for bookkeeping. */
export function retireStructuredAgentSessionTab(args: {
  target: RuntimeClientTarget
  worktreeId: string
  sessionId: string
  onError?: (error: unknown) => void
}): Promise<void> {
  retireStructuredAgentSessionReadOwner(args.sessionId, args.target)
  const key = retirementKey(args.target, args.worktreeId, args.sessionId)
  const existing = inFlightRetirements.get(key)
  if (existing) {
    return existing
  }
  const hostTabId = structuredAgentSessionHostTabId(args.sessionId)
  // Why: main echoes the host tab id it was asked to close, never this window's tab id.
  const closeHostTab = () =>
    withLocalSessionTabCloseOwner(args.worktreeId, hostTabId, () =>
      callRuntimeRpc(args.target, 'session.tabs.close', {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        tabId: hostTabId,
        reason: 'user'
      })
    )
  const promise = Promise.allSettled([
    closeStructuredAgentSession(args.target, args.sessionId),
    closeHostTab()
  ]).then((results) => {
    inFlightRetirements.delete(key)
    for (const result of results) {
      if (result.status === 'rejected') {
        if (args.onError) {
          args.onError(result.reason)
        } else {
          console.warn('[structured-agent-session] host retirement failed', result.reason)
        }
      }
    }
  })
  inFlightRetirements.set(key, promise)
  return promise
}

/** Re-reads the host's tab list, which supersedes whatever a close's in-flight hold suppressed. */
function resyncHostSessionTabs(target: RuntimeClientTarget, worktreeId: string): void {
  // Lazy imports: both refresh paths apply frames through this module.
  const resync =
    target.kind === 'environment'
      ? import('./web-runtime-session-snapshot').then(({ refreshWebRuntimeSessionTabsSnapshot }) =>
          refreshWebRuntimeSessionTabsSnapshot(target.environmentId, worktreeId, {
            acceptCurrentSnapshot: true
          })
        )
      : import('./local-structured-session-tabs-sync/inventory-refresh').then(
          ({ refreshLocalStructuredSessionTabs }) =>
            refreshLocalStructuredSessionTabs(undefined, { reacceptCurrentVersion: true })
        )
  resync.catch((error: unknown) =>
    console.warn('[structured-agent-session] tab resync after close failed', error)
  )
}

/** Mark cancellation before removing the row so a late host publication cannot resurrect it. */
export function beginStructuredAgentSessionTabClose(args: {
  target: RuntimeClientTarget
  worktreeId: string
  sessionId: string
  provisional: boolean
  onError?: (error: unknown) => void
}): void {
  if (args.provisional) {
    markStructuredAgentSessionLaunchCancelled(
      args.worktreeId,
      args.sessionId,
      executionHostIdForStructuredTarget(args.target)
    )
    discardStructuredAgentSessionChatSends(args.sessionId)
  } else {
    // Nothing more goes out, and nothing is dropped: one on its way settles from its answer, and
    // the rest goes back to the conversation's draft.
    stopStructuredAgentSessionSends(args.sessionId)
  }
  // Why: the close's hold hid this chat from host frames, so a host that refused or never got the
  // close must be asked again, or the chat it kept stays off screen.
  void retireStructuredAgentSessionTab(args).then(() =>
    resyncHostSessionTabs(args.target, args.worktreeId)
  )
}

/**
 * A paired host's frame, as this client may apply it: chats cancelled before their create landed
 * are retired on that host, and the rest settle any launch still waiting to learn they exist.
 */
export function acceptPairedHostStructuredSessions(
  frame: RuntimeMobileSessionTabsResult,
  environmentId: string
): RuntimeMobileSessionTabsResult {
  const snapshot = suppressClosedStructuredSessionTabs(frame, {
    kind: 'environment',
    environmentId
  })
  markStructuredAgentSessionLaunchesPublished(
    toRuntimeExecutionHostId(environmentId),
    publishedStructuredSessions([snapshot])
  )
  return snapshot
}

/**
 * A host snapshot minus the chats this window closed: a cancelled launch is retired again
 * idempotently, and a chat stays hidden until the host answers its close, since a frame sent
 * before the host handled it still lists the chat and would re-add it at the end of the strip.
 */
export function suppressClosedStructuredSessionTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  target: RuntimeClientTarget,
  onError?: (error: unknown) => void
): RuntimeMobileSessionTabsResult {
  const cancelledSessionIds = new Set<string>()
  const hiddenSessionIds = new Set<string>()
  for (const tab of snapshot.tabs) {
    if (tab.type !== 'agent-session') {
      continue
    }
    if (hasStructuredAgentSessionLaunchCancellationTombstone(snapshot.worktree, tab.sessionId)) {
      cancelledSessionIds.add(tab.sessionId)
      hiddenSessionIds.add(tab.sessionId)
    } else if (
      isLocalSessionTabCloseOwned(snapshot.worktree, structuredAgentSessionHostTabId(tab.sessionId))
    ) {
      hiddenSessionIds.add(tab.sessionId)
    }
  }
  if (hiddenSessionIds.size === 0) {
    return snapshot
  }
  for (const sessionId of cancelledSessionIds) {
    void retireStructuredAgentSessionTab({
      target,
      worktreeId: snapshot.worktree,
      sessionId,
      onError
    })
  }
  const tabs = snapshot.tabs.filter(
    (tab) => tab.type !== 'agent-session' || !hiddenSessionIds.has(tab.sessionId)
  )
  const visibleTabIds = new Set(tabs.map((tab) => tab.id))
  return {
    ...snapshot,
    tabs,
    activeTabId:
      snapshot.activeTabId && visibleTabIds.has(snapshot.activeTabId) ? snapshot.activeTabId : null,
    activeTabType:
      snapshot.activeTabId && visibleTabIds.has(snapshot.activeTabId)
        ? snapshot.activeTabType
        : null,
    tabGroups: snapshot.tabGroups
      ?.map((group) => ({
        ...group,
        tabOrder: group.tabOrder.filter((id) => visibleTabIds.has(id)),
        activeTabId:
          group.activeTabId && visibleTabIds.has(group.activeTabId) ? group.activeTabId : null,
        recentTabIds: group.recentTabIds?.filter((id) => visibleTabIds.has(id))
      }))
      .filter((group) => group.tabOrder.length > 0)
  }
}
