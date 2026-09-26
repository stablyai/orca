import type { TuiAgent } from '../../../shared/tui-agent'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { showAutomationPromptNotSentToast } from '@/lib/agent-background-session-timeout-toast'

// Why: an unattended launch cannot rely on the interactive 8s readiness
// window — a cold-starting TUI regularly needs longer, and a dropped prompt
// leaves the run 'dispatched' forever with a silently idle agent. Retry while
// delivery timed out before any bytes were written; a `false` return after a
// write attempt is ambiguous (the composer may already hold the text), so
// retrying then would risk pasting a second copy.
const BACKGROUND_DRAFT_DELIVERY_ATTEMPTS = 3
const BACKGROUND_DRAFT_RETRY_DELAY_MS = 3000

type DraftDeliveryListener = (delivered: boolean) => void
const draftDeliveryListeners = new Map<string, Set<DraftDeliveryListener>>()
const pendingDraftDeliveryResults = new Map<string, boolean>()

/** Observe the outcome of a scheduled background draft on `tabId`. The
 *  listener fires once; it is the caller's job to unsubscribe. A result that
 *  landed before anyone subscribed is delivered on the next microtask. */
export function subscribeAgentBackgroundDraftDelivery(
  tabId: string,
  listener: DraftDeliveryListener
): () => void {
  const pending = pendingDraftDeliveryResults.get(tabId)
  if (pending !== undefined) {
    pendingDraftDeliveryResults.delete(tabId)
    // Why: microtask so a buffered result cannot fire before `subscribe`
    // returns — callers unsubscribe through the handle this returns.
    let active = true
    queueMicrotask(() => {
      if (active) {
        listener(pending)
      }
    })
    return () => {
      active = false
    }
  }
  let listeners = draftDeliveryListeners.get(tabId)
  if (!listeners) {
    listeners = new Set()
    draftDeliveryListeners.set(tabId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      draftDeliveryListeners.delete(tabId)
    }
  }
}

function notifyDraftDelivery(tabId: string, delivered: boolean): void {
  const listeners = draftDeliveryListeners.get(tabId)
  if (!listeners || listeners.size === 0) {
    // The dispatch handler subscribes after `launchAgentBackgroundSession`
    // returns, while delivery runs concurrently — keep the verdict until then.
    pendingDraftDeliveryResults.set(tabId, delivered)
    return
  }
  listeners.forEach((listener) => listener(delivered))
}

export function scheduleAgentBackgroundDraft(
  tabId: string,
  content: string,
  agent: TuiAgent
): void {
  pendingDraftDeliveryResults.delete(tabId)
  void (async () => {
    let delivered = false
    try {
      for (
        let attempt = 0;
        attempt < BACKGROUND_DRAFT_DELIVERY_ATTEMPTS && !delivered;
        attempt += 1
      ) {
        if (attempt > 0) {
          await new Promise<void>((resolve) =>
            window.setTimeout(resolve, BACKGROUND_DRAFT_RETRY_DELAY_MS)
          )
        }
        let timedOut = false
        delivered = await pasteDraftWhenAgentReady({
          tabId,
          content,
          agent,
          submit: true,
          onTimeout: () => {
            timedOut = true
          }
        })
        if (!delivered && !timedOut) {
          break
        }
      }
    } catch (error) {
      console.error('[automations] Background draft delivery threw:', error)
    }
    // Why: an armed delivery gate awaits this verdict — a thrown paste must
    // not strand it.
    notifyDraftDelivery(tabId, delivered)
    if (!delivered) {
      showAutomationPromptNotSentToast(agent)
    }
  })()
}
