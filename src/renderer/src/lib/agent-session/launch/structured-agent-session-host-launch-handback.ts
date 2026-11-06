/** A host launch's opening on its way back to the chat's composer, from the moment it joins the
 *  draft until both ends are durable: the draft holds it (its receipt is saved) and the launch's
 *  own saved row no longer does. One obligation per launch, whatever its Retries; it owns the one
 *  draft-commit subscription and the launch's source files until then, and it is rebuilt from the
 *  saved draft receipt and launch row after a reload. Every wake (the handback itself, a Retry, a
 *  draft commit, a launch journal save, a reload, Close) reconciles it the same way. */

import {
  nativeChatDraftReceiptDurable,
  retireNativeChatDraftReceipt,
  subscribeNativeChatDraftReceiptCommit,
  type NativeChatDraftHandbackReceipt
} from '@/components/native-chat/native-chat-composer-draft-handback'
import {
  structuredAgentSessionDraftScopeKey,
  structuredAgentSessionIdOfDraftScope
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  structuredAgentLaunchOpeningRetired,
  subscribeStructuredAgentLaunchRecordsSaved
} from './structured-agent-session-launch-persistence'
import {
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchIntentChanged
} from './structured-agent-session-launch-registry'
import { retireHostLaunchSources } from './structured-agent-session-host-launch-sources'

type Obligation = {
  receipt: NativeChatDraftHandbackReceipt
  scope: string
  /** Removes the draft-commit subscription while the draft's receipt is not yet durable. */
  stopDraft?: () => void
}

const obligations = new Map<string, Obligation>()
// One journal-save subscription while any obligation waits on its launch's row.
let stopSourceSaves: (() => void) | undefined

/** Holds the obligation for `sessionId`'s returned opening and reconciles it now. */
export function holdHostLaunchHandback(
  sessionId: string,
  receipt: NativeChatDraftHandbackReceipt
): void {
  const held = obligations.get(sessionId)
  if (
    !held ||
    held.receipt.operationId !== receipt.operationId ||
    held.receipt.clientMessageId !== receipt.clientMessageId
  ) {
    held?.stopDraft?.()
    obligations.set(sessionId, {
      receipt,
      scope: structuredAgentSessionDraftScopeKey(sessionId)
    })
  }
  reconcileHostLaunchHandback(sessionId)
}

/** Advances the obligation as far as durable truth allows: once the draft holds the opening the
 *  launch stops emitting it and saves its row without it; once that row is saved the launch's
 *  files and the draft's receipt end. Anything not yet durable waits on its one wake. */
export function reconcileHostLaunchHandback(sessionId: string): void {
  const held = obligations.get(sessionId)
  if (!held) {
    return
  }
  const { receipt, scope } = held
  if (!nativeChatDraftReceiptDurable(scope, receipt)) {
    held.stopDraft ??= subscribeNativeChatDraftReceiptCommit(scope, receipt, (durable) => {
      if (durable && obligations.get(sessionId) === held) {
        held.stopDraft?.()
        delete held.stopDraft
        reconcileHostLaunchHandback(sessionId)
      }
    })
    return
  }
  held.stopDraft?.()
  delete held.stopDraft
  const state = getStructuredLaunchStateBySessionId(sessionId)
  const intent = state?.intent
  if (
    intent?.opening?.clientMessageId === receipt.clientMessageId &&
    intent.hostLaunch?.operationId === receipt.operationId
  ) {
    // The draft holds it: the launch no longer emits it, and saves its row without it.
    delete intent.opening
    notifyStructuredLaunchIntentChanged(intent)
  }
  if (!structuredAgentLaunchOpeningRetired(sessionId)) {
    stopSourceSaves ??= subscribeStructuredAgentLaunchRecordsSaved(reconcileAllHostLaunchHandbacks)
    return
  }
  if (intent?.hostLaunch?.operationId === receipt.operationId) {
    retireHostLaunchSources(intent)
  }
  obligations.delete(sessionId)
  retireNativeChatDraftReceipt(scope, receipt)
  if (obligations.size === 0) {
    stopSourceSaves?.()
    stopSourceSaves = undefined
  }
}

function reconcileAllHostLaunchHandbacks(): void {
  for (const sessionId of obligations.keys()) {
    reconcileHostLaunchHandback(sessionId)
  }
}

/** A receipt found in a draft after a reload: the obligation it proves is rebuilt and reconciled. */
export function reconcileRestoredHostLaunchHandback(
  scope: string,
  receipt: NativeChatDraftHandbackReceipt
): void {
  // The chat's own draft scope names its session; no receipt needs to repeat it.
  const sessionId = structuredAgentSessionIdOfDraftScope(scope)
  if (sessionId) {
    holdHostLaunchHandback(sessionId, receipt)
  }
}

/** The launch was closed or removed: its obligation's subscriptions end at once. Its draft and
 *  receipt go with the chat's own deletion; a late commit finds nothing to revive. */
export function endHostLaunchHandback(sessionId: string): void {
  const held = obligations.get(sessionId)
  if (!held) {
    return
  }
  held.stopDraft?.()
  obligations.delete(sessionId)
  if (obligations.size === 0) {
    stopSourceSaves?.()
    stopSourceSaves = undefined
  }
}

export function resetHostLaunchHandbacksForTests(): void {
  for (const sessionId of obligations.keys()) {
    endHostLaunchHandback(sessionId)
  }
}
