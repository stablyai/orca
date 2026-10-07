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
import { closeStructuredAgentSession } from './structured-agent-session-close'
import { withLocalSessionTabCloseOwner } from './local-session-tab-close-owner'
import { executionHostIdForStructuredTarget } from './structured-agent-session-owner'
import { callRuntimeRpc, type RuntimeClientTarget } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

const inFlightRetirements = new Map<string, Promise<void>>()

function retirementKey(target: RuntimeClientTarget, worktreeId: string, sessionId: string): string {
  return `${target.kind}:${target.kind === 'environment' ? target.environmentId : 'local'}:${worktreeId}:${sessionId}`
}

/** Best-effort host cleanup; local removal must never wait for bookkeeping. */
export function retireStructuredAgentSessionTab(args: {
  target: RuntimeClientTarget
  worktreeId: string
  sessionId: string
  onError?: (error: unknown) => void
}): void {
  const key = retirementKey(args.target, args.worktreeId, args.sessionId)
  const existing = inFlightRetirements.get(key)
  if (existing) {
    return
  }
  const hostTabId = `agent-session:${args.sessionId}`
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
  retireStructuredAgentSessionTab(args)
}

/**
 * A paired host's frame, as this client may apply it: chats cancelled before their create landed
 * are retired on that host, and the rest settle any launch still waiting to learn they exist.
 */
export function acceptPairedHostStructuredSessions(
  frame: RuntimeMobileSessionTabsResult,
  environmentId: string
): RuntimeMobileSessionTabsResult {
  const snapshot = suppressCancelledStructuredSessionTabs(frame, {
    kind: 'environment',
    environmentId
  })
  markStructuredAgentSessionLaunchesPublished(
    toRuntimeExecutionHostId(environmentId),
    publishedStructuredSessions([snapshot])
  )
  return snapshot
}

/** A host snapshot containing a cancelled session is suppressed and retired again idempotently. */
export function suppressCancelledStructuredSessionTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  target: RuntimeClientTarget,
  onError?: (error: unknown) => void
): RuntimeMobileSessionTabsResult {
  const cancelledSessionIds = new Set<string>()
  for (const tab of snapshot.tabs) {
    if (
      tab.type === 'agent-session' &&
      hasStructuredAgentSessionLaunchCancellationTombstone(snapshot.worktree, tab.sessionId)
    ) {
      cancelledSessionIds.add(tab.sessionId)
    }
  }
  if (cancelledSessionIds.size === 0) {
    return snapshot
  }
  for (const sessionId of cancelledSessionIds) {
    retireStructuredAgentSessionTab({
      target,
      worktreeId: snapshot.worktree,
      sessionId,
      onError
    })
  }
  const tabs = snapshot.tabs.filter(
    (tab) => tab.type !== 'agent-session' || !cancelledSessionIds.has(tab.sessionId)
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
