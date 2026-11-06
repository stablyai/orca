/** A host launch's opening on its way back to the chat's composer, from the moment it joins the
 *  draft until nothing of it is owed anywhere. Three facts end it, in order, each proved by its
 *  own witness: the draft holds it completely (its saved base read, with the receipt) and backed
 *  up, so the launch stops emitting it and saves its row without it; that row saved, so the
 *  launch's files end; and the draft's receipt and any replay of the returned input discharged.
 *  One obligation per launch, whatever its Retries, with one draft-progress subscription that
 *  follows every step; it is rebuilt from the saved receipt and launch row after a reload. Every
 *  wake (the handback itself, a Retry, draft progress, a launch journal save, a reload, Close)
 *  reconciles it the same way. */

import {
  nativeChatDraftReceiptProgress,
  retireNativeChatDraftReceipt,
  subscribeNativeChatDraftReceiptProgress,
  type NativeChatDraftHandbackReceipt,
  type NativeChatDraftReceiptProgress
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
  /** The one draft-progress subscription, kept until the obligation ends. */
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

/** Advances the obligation as far as its witnesses allow; anything not yet proved waits on its
 *  wake. A backup of the returned input alone never lets the launch let go of it. The draft
 *  delivers the receipt's completion to this obligation's own subscription, which ends it. */
export function reconcileHostLaunchHandback(
  sessionId: string,
  delivered?: NativeChatDraftReceiptProgress
): void {
  const held = obligations.get(sessionId)
  if (!held) {
    return
  }
  const { receipt, scope } = held
  held.stopDraft ??= subscribeNativeChatDraftReceiptProgress(scope, receipt, (next) => {
    if (obligations.get(sessionId) === held) {
      reconcileHostLaunchHandback(sessionId, next)
    }
  })
  const progress = delivered ?? nativeChatDraftReceiptProgress(scope, receipt)
  if (!progress.retired && !(progress.backed && progress.incorporated)) {
    return
  }
  const state = getStructuredLaunchStateBySessionId(sessionId)
  const intent = state?.intent
  if (
    intent?.opening?.clientMessageId === receipt.clientMessageId &&
    intent.hostLaunch?.operationId === receipt.operationId
  ) {
    // The draft holds it completely: the launch no longer emits it, and saves its row without it.
    delete intent.opening
    notifyStructuredLaunchIntentChanged(intent)
  }
  if (!structuredAgentLaunchOpeningRetired(sessionId)) {
    stopSourceSaves ??= subscribeStructuredAgentLaunchRecordsSaved(reconcileAllHostLaunchHandbacks)
    return
  }
  // The draft's own reference holds any file that came back; the launch's hold ends.
  if (intent?.hostLaunch?.operationId === receipt.operationId) {
    retireHostLaunchSources(intent)
  }
  if (!progress.retired) {
    retireNativeChatDraftReceipt(scope, receipt)
    return
  }
  endHostLaunchHandback(sessionId)
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
