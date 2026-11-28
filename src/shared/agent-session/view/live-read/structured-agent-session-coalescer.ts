import {
  holdProviderReceived,
  isProviderReceiptOnly,
  pruneHeldReceipts,
  type ReceiptBatch
} from './agent-session-provider-received'
import type { AgentSessionSubscribeEvent } from '../../agent-session-wire'
import {
  actionablePromptIdsAfterStructuredAgentSessionBatch,
  hostWorkingAfterStructuredAgentSessionBatch,
  latestTurnAfterStructuredAgentSessionBatch
} from '../structured-agent-session-live-turn'

export const STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS = 48

function bypassCoalescing(event: AgentSessionSubscribeEvent): boolean {
  return (
    event.type !== 'batch' ||
    // Deliver queue lists immediately or the queued response removes Sending before its replacement card arrives.
    event.queuedMessages !== undefined ||
    event.currentRequests !== undefined ||
    event.batch.removedItemIds.length > 0 ||
    // Replies and reasoning are what stream; every other row applies at once.
    event.batch.items.some(
      (item) =>
        item.body.kind !== 'message' ||
        (item.body.role !== 'assistant' && item.body.role !== 'reasoning')
    )
  )
}

type Batch = Extract<AgentSessionSubscribeEvent, { type: 'batch' }>
type BatchSubmission = Batch['batch']['submissions'][number]

/** Batches merged while held: rows and submissions keyed once, so each push costs its own rows,
 *  not a copy of everything held (a hidden viewer can hold many). */
type HeldBatches = ReceiptBatch & { submissions: Map<string, BatchSubmission> }

function holdBatch(event: Batch): HeldBatches {
  const held: HeldBatches = {
    first: event,
    merged: null,
    items: new Map(event.batch.items.map((item) => [item.itemId, item])),
    submissions: new Map(
      event.batch.submissions.map((submission) => [submission.clientMessageId, submission])
    )
  }
  return held
}

function addToHeld(held: HeldBatches, right: Batch): void {
  for (const item of right.batch.items) {
    // A live snapshot read before a save can arrive after it; the older revision must not win.
    if ((held.items.get(item.itemId)?.revision ?? -Infinity) <= item.revision) {
      held.items.set(item.itemId, item)
    }
  }
  for (const submission of right.batch.submissions) {
    held.submissions.set(submission.clientMessageId, submission)
  }
  const left = held.merged ?? held.first
  held.merged = mergeBatchHeader(left, right)
}

function heldEvent(held: HeldBatches): Batch {
  const event = held.merged
    ? {
        ...held.merged,
        batch: {
          ...held.merged.batch,
          items: [...held.items.values()],
          submissions: [...held.submissions.values()]
        }
      }
    : held.first
  if (held.providerReceived?.size) {
    return { ...event, providerReceived: [...held.providerReceived] }
  }
  if (event.providerReceived) {
    const { providerReceived: _cleared, ...batch } = event
    return batch
  }
  return event
}

function mergeBatchHeader(left: Batch, right: Batch): Batch {
  // Match sequential application, including older-host rows clearing stale claims.
  const latestTurn = latestTurnAfterStructuredAgentSessionBatch(left.latestTurn, right)
  const actionablePromptIds = actionablePromptIdsAfterStructuredAgentSessionBatch(
    left.actionablePromptIds,
    right
  )
  const working = hostWorkingAfterStructuredAgentSessionBatch(left.working, right)
  return {
    type: 'batch',
    ...(left.commandsChanged || right.commandsChanged ? { commandsChanged: true as const } : {}),
    ...(right.commands !== undefined || left.commands !== undefined
      ? { commands: right.commands !== undefined ? right.commands : left.commands }
      : {}),
    sessionId: right.sessionId,
    batch: { cursor: right.batch.cursor, items: [], removedItemIds: [], submissions: [] },
    ...(right.fence !== undefined || left.fence !== undefined
      ? { fence: right.fence ?? left.fence }
      : {}),
    ...(right.backgroundTasks !== undefined || left.backgroundTasks !== undefined
      ? {
          backgroundTasks:
            right.backgroundTasks !== undefined
              ? right.backgroundTasks
              : (left.backgroundTasks ?? null)
        }
      : {}),
    ...(right.activity !== undefined || left.activity !== undefined
      ? { activity: right.activity !== undefined ? right.activity : (left.activity ?? null) }
      : {}),
    ...(right.promptSuggestion !== undefined || left.promptSuggestion !== undefined
      ? {
          promptSuggestion:
            right.promptSuggestion !== undefined
              ? right.promptSuggestion
              : (left.promptSuggestion ?? null)
        }
      : {}),
    ...(latestTurn !== undefined ? { latestTurn } : {}),
    ...(actionablePromptIds !== undefined ? { actionablePromptIds } : {}),
    ...(working !== undefined ? { working } : {}),
    // Only the final merged page can end catch-up.
    ...(right.hasNewer ? { hasNewer: true as const } : {})
  }
}

/** Whether the viewer is hidden (a minimized window, a backgrounded phone), and when it shows. */
export type StructuredAgentSessionViewerVisibility = {
  hidden: () => boolean
  subscribeShown: (shown: () => void) => () => void
  /** Called just before text held while hidden is drawn. */
  heldDrawn?: () => void
  /** Whether the host sends this viewer its newest text when it says it is shown; the held text
   *  then waits for it, so the first frame after showing has it. */
  sendsShownTail?: () => boolean
}

/** How long a shown viewer's held text waits for the host's newest text before drawing alone. */
const SHOWN_TAIL_WAIT_MS = 300

export type StructuredAgentSessionCoalescing = {
  /** How long streamed text batches wait to merge. */
  ms?: number
  /** While hidden, batches keep merging instead of applying, and apply at once when shown. */
  visibility?: StructuredAgentSessionViewerVisibility
  receiptLimit?: () => number
  pendingReceiptSequence?: (itemId: string) => number | undefined
}

export function createStructuredAgentSessionEventCoalescer(
  emit: (event: AgentSessionSubscribeEvent) => void,
  {
    ms: delayMs = STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS,
    visibility,
    receiptLimit,
    pendingReceiptSequence
  }: StructuredAgentSessionCoalescing = {}
): {
  push: (event: AgentSessionSubscribeEvent) => void
  flush: () => void
  dispose: () => void
  clearProviderReceived: () => void
} {
  let pending: HeldBatches | null = null
  let parkedReceipt: HeldBatches | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let awaitingTail: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (awaitingTail) {
      clearTimeout(awaitingTail)
      awaitingTail = null
    }
    if (pending) {
      const event = heldEvent(pending)
      pending = null
      emit(event)
    }
    if (parkedReceipt && !visibility?.hidden()) {
      const event = heldEvent(parkedReceipt)
      parkedReceipt = null
      if (event.providerReceived?.length && receiptLimit?.()) {
        emit(event)
      }
    }
  }
  const drawHeld = (): void => {
    visibility?.heldDrawn?.()
    flush()
  }
  const stopShownWatch = visibility?.subscribeShown(() => {
    if (parkedReceipt && !pending) {
      flush()
    }
    if (visibility.sendsShownTail?.() === true) {
      awaitingTail ??= setTimeout(() => (pending ? drawHeld() : flush()), SHOWN_TAIL_WAIT_MS)
      return
    }
    if (pending) {
      visibility.heldDrawn?.()
    }
    flush()
  })
  return {
    push(event) {
      const limit = receiptLimit?.() ?? 0
      if (receiptLimit && event.type === 'batch' && isProviderReceiptOnly(event)) {
        if (!limit) {
          return
        }
        if (pending) {
          const header = pending.merged ?? pending.first
          const { cursor } = header.batch
          if (
            event.fence === header.fence &&
            event.batch.cursor.epoch === cursor.epoch &&
            event.batch.cursor.sequence <= cursor.sequence
          ) {
            holdProviderReceived(pending, event, limit)
          }
        } else if (visibility?.hidden()) {
          parkedReceipt ??= holdBatch(event)
          holdProviderReceived(parkedReceipt, event, limit)
        } else {
          emit(event)
        }
        return
      }
      if (bypassCoalescing(event)) {
        const held = pending ?? parkedReceipt
        if (held && event.type === 'batch') {
          pruneHeldReceipts(held, event, pendingReceiptSequence)
          if (parkedReceipt) {
            const first = parkedReceipt.first
            parkedReceipt.merged = {
              ...first,
              batch: { ...first.batch, cursor: event.batch.cursor }
            }
          }
        }
        if (awaitingTail && pending) {
          visibility?.heldDrawn?.()
        }
        flush()
        emit(event)
        return
      }
      if (event.type !== 'batch') {
        return
      }
      if (parkedReceipt) {
        pending = parkedReceipt
        parkedReceipt = null
      }
      if (pending) {
        holdProviderReceived(pending, event, limit)
        pruneHeldReceipts(pending, event, pendingReceiptSequence)
        addToHeld(pending, event)
      } else {
        pending = holdBatch(event)
        holdProviderReceived(pending, event, limit)
      }
      // The host's newest text for a viewer that just showed: drawn at once, with what was held.
      if (awaitingTail) {
        drawHeld()
        return
      }
      timer ??= setTimeout(() => (visibility?.hidden() ? (timer = null) : flush()), delayMs)
    },
    flush,
    clearProviderReceived() {
      parkedReceipt = null
      if (pending) {
        pending.providerReceived = undefined
      }
    },
    dispose() {
      stopShownWatch?.()
      if (timer) {
        clearTimeout(timer)
      }
      if (awaitingTail) {
        clearTimeout(awaitingTail)
      }
      timer = null
      awaitingTail = null
      pending = null
      parkedReceipt = null
    }
  }
}
