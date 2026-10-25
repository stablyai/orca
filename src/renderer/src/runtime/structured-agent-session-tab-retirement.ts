import type { StructuredLaunchSlotOwner } from '@/lib/structured-agent-session-launch-slot'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  hasStructuredAgentSessionLaunchCancellationTombstone,
  markStructuredAgentSessionLaunchCancelled
} from '@/lib/structured-agent-session-launch-registry'
import { forgetUnlistedCreatedChat } from '@/lib/structured-agent-session-unlisted-created-chats'
import { discardStructuredAgentSessionChatSends } from '@/lib/structured-agent-session-launch-prompt'
import { stopStructuredAgentSessionSends } from '@/components/native-chat/structured-agent-session-message-sender'
import { retireStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner-registry'
import { closeStructuredAgentSession } from './structured-agent-session-close'
import { withLocalSessionTabCloseOwner } from './local-session-tab-close-owner'
import {
  executionHostIdForStructuredTarget,
  structuredAgentSessionFocusOwner
} from './structured-agent-session-owner'
import { clearWebSessionCloseIntent, recordWebSessionCloseIntent } from './web-session-close-intent'
import type { WebSessionIntentOwner } from './web-session-intent-owner'
import { captureWebSessionIntentOwner } from './web-runtime-session-environment'
import { callRuntimeRpc } from './runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

const inFlightRetirements = new Map<string, Promise<boolean>>()

function retirementKey(target: RuntimeClientTarget, worktreeId: string, sessionId: string): string {
  return `${target.kind}:${target.kind === 'environment' ? target.environmentId : 'local'}:${worktreeId}:${sessionId}`
}

/**
 * Best-effort host cleanup; local removal must never wait for bookkeeping. Resolves false when the
 * host tab close failed, so the host may still list the chat.
 */
export function retireStructuredAgentSessionTab(args: {
  target: RuntimeClientTarget
  worktreeId: string
  sessionId: string
  onError?: (error: unknown) => void
}): Promise<boolean> {
  retireStructuredAgentSessionReadOwner(args.sessionId, args.target)
  const key = retirementKey(args.target, args.worktreeId, args.sessionId)
  const existing = inFlightRetirements.get(key)
  if (existing) {
    return existing
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
    const [, hostTabClose] = results
    return hostTabClose.status === 'fulfilled'
  })
  inFlightRetirements.set(key, promise)
  return promise
}

/** Re-reads one worktree from the host, including the version already applied, which the window's
 *  early removal left out of date. */
function reacceptHostSessionTabs(
  target: RuntimeClientTarget,
  worktreeId: string,
  intentOwner: WebSessionIntentOwner,
  /** This machine's host still lists the chat. */
  stillListed?: { sessionId: string; reopen: () => void }
): void {
  // Lazy imports: both refresh paths apply frames through this module.
  const reread =
    target.kind === 'environment'
      ? import('./web-runtime-session-snapshot').then(({ refreshWebRuntimeSessionTabsSnapshot }) =>
          refreshWebRuntimeSessionTabsSnapshot(target.environmentId, worktreeId, {
            acceptCurrentSnapshot: true,
            // A read that began before the close would still list the chat.
            afterCurrentInFlight: true,
            expectedEnvironmentPairingRevision: intentOwner.pairingRevision
          })
        )
      : import('./local-structured-session-tabs-sync/inventory-refresh').then(
          async ({ refreshLocalStructuredSessionWorktreeTabs }) => {
            const listed = await refreshLocalStructuredSessionWorktreeTabs(worktreeId, {
              reacceptCurrentVersion: true
            })
            if (
              stillListed &&
              listed?.tabs.some(
                (tab) => tab.type === 'agent-session' && tab.sessionId === stillListed.sessionId
              )
            ) {
              stillListed.reopen()
            }
          }
        )
  reread.catch((error: unknown) =>
    console.warn('[structured-agent-session] tab re-read after a close failed', error)
  )
}

/** Mark cancellation before removing the row so a late host publication cannot resurrect it. */
export function beginStructuredAgentSessionTabClose(args: {
  target: RuntimeClientTarget
  worktreeId: string
  sessionId: string
  provisional: boolean
  layoutOwner: StructuredLaunchSlotOwner
  onError?: (error: unknown) => void
  /** Main dropped the tab before the host answered: a host still listing the chat shows it again. */
  reopen?: () => void
}): void {
  forgetUnlistedCreatedChat(args.worktreeId, args.sessionId)
  if (args.provisional) {
    markStructuredAgentSessionLaunchCancelled(
      args.worktreeId,
      args.sessionId,
      executionHostIdForStructuredTarget(args.target),
      args.layoutOwner
    )
    discardStructuredAgentSessionChatSends(args.sessionId)
  } else {
    // Withdraw unsent sends back to draft; in-flight work settles from its own answer.
    stopStructuredAgentSessionSends(args.sessionId)
  }
  // Pinned to the pairing at close start, so a re-pair mid-close can't miss the clear.
  const intentOwner = captureWebSessionIntentOwner(
    structuredAgentSessionFocusOwner(args.target).environmentId
  )
  const hostTabId = `agent-session:${args.sessionId}`
  // Hold close intent until a host frame omits the chat; pre-close frames would otherwise reappend it.
  recordWebSessionCloseIntent(intentOwner, args.worktreeId, hostTabId, Date.now())
  void retireStructuredAgentSessionTab(args).then((hostTabClosed) => {
    if (!hostTabClosed) {
      // The host may still have the chat: let its list show it again.
      clearWebSessionCloseIntent(intentOwner, args.worktreeId, hostTabId)
    }
    // Local removal frames precede close replies, so refetch only on failure. Paired frames race replies; always refetch like terminal close.
    if (!hostTabClosed || args.target.kind === 'environment') {
      reacceptHostSessionTabs(
        args.target,
        args.worktreeId,
        intentOwner,
        !hostTabClosed && args.reopen
          ? { sessionId: args.sessionId, reopen: args.reopen }
          : undefined
      )
    }
  })
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
    void retireStructuredAgentSessionTab({
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
