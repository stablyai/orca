import type { StructuredLaunchSlotOwner } from '@/lib/agent-session/launch/structured-agent-session-launch-slot'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import { hasStructuredAgentSessionLaunchCancellationTombstone } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { markStructuredAgentSessionLaunchCancelled } from '@/lib/agent-session/launch/structured-agent-session-launch-cancel'
import { forgetUnlistedCreatedChat } from '@/lib/agent-session/launch/pane/structured-agent-session-unlisted-created-chats'
import { discardStructuredAgentSessionChatSends } from '@/lib/agent-session/launch/structured-agent-session-staged-prompt'
import { stopStructuredAgentSessionSends } from '@/components/native-chat/session/structured/delivery/structured-agent-session-message-sender'
import {
  executionHostIdForStructuredTarget,
  structuredAgentSessionFocusOwner
} from '../session-ownership/structured-agent-session-owner'
import {
  clearWebSessionCloseIntent,
  recordWebSessionCloseIntent
} from '../../web-session-tabs-sync/closing/web-session-close-intent'
import type { WebSessionIntentOwner } from '../../web-session-tabs-sync/identity/web-session-intent-owner'
import { captureWebSessionIntentOwner } from '../../web-session-tabs-sync/identity/web-runtime-session-environment'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { retireStructuredAgentSessionTab } from './structured-agent-session-host-tab-retirement'

export { retireStructuredAgentSessionTab }

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
      ? import('../../web-session-tabs-sync/inventory/web-runtime-session-snapshot').then(
          ({ refreshWebRuntimeSessionTabsSnapshot }) =>
            refreshWebRuntimeSessionTabsSnapshot(target.environmentId, worktreeId, {
              acceptCurrentSnapshot: true,
              // A read that began before the close would still list the chat.
              afterCurrentInFlight: true,
              expectedEnvironmentPairingRevision: intentOwner.pairingRevision
            })
        )
      : import('../../local-structured-session-tabs-sync/inventory-refresh').then(
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
