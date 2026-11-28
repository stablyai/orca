import { agentJournalSubmissionKey } from '../../journal/agent-session-journal-item-key'
import { isProviderReceiptOnly } from './agent-session-provider-received'
import {
  AGENT_SESSION_DISPATCH_LIMITS,
  type AgentSessionReceiptProvider
} from '../../journal/agent-session-dispatch-limits'
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
type BatchRow = Batch['batch']['items'][number]
type BatchSubmission = Batch['batch']['submissions'][number]

/** Batches merged while held: rows and submissions keyed once, so each push costs its own rows,
 *  not a copy of everything held (a hidden viewer can hold many). */
type HeldBatches = {
  first: Batch
  /** The merged header; its row lists are filled from the maps when drawn. */
  merged: Batch | null
  items: Map<string, BatchRow>
  submissions: Map<string, BatchSubmission>
  providerReceived?: Set<number>
}

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

function holdProviderReceived(held: HeldBatches, event: Batch, limit: number): void {
  if (!event.providerReceived?.length || limit === 0) {
    return
  }
  const received = (held.providerReceived ??= new Set())
  for (let index = 0; index < Math.min(event.providerReceived.length, limit); index++) {
    if (received.size >= limit) {
      break
    }
    received.add(event.providerReceived[index]!)
  }
}

function pruneHeldReceipts(
  held: HeldBatches,
  event: Batch,
  pendingSequence: ((id: string) => number | undefined) | undefined
): void {
  const received = held.providerReceived
  if (!received?.size) {
    return
  }
  const left = held.merged ?? held.first
  if (
    left.batch.cursor.epoch !== event.batch.cursor.epoch ||
    (event.fence !== undefined && event.fence !== left.fence)
  ) {
    received.clear()
    return
  }
  for (const submission of event.batch.submissions) {
    if (submission.dispatchState !== 'pending') {
      const id = agentJournalSubmissionKey(submission.clientMessageId)
      const sequence = held.items.get(id)?.sequence ?? pendingSequence?.(id)
      if (sequence !== undefined) {
        received.delete(sequence)
      }
    }
  }
  for (const { itemId, sequence } of event.batch.items) {
    const previous = held.items.get(itemId)?.sequence ?? pendingSequence?.(itemId)
    if (previous !== undefined && previous !== sequence) {
      received.delete(previous)
    }
  }
  for (const itemId of event.batch.removedItemIds) {
    const sequence = held.items.get(itemId)?.sequence ?? pendingSequence?.(itemId)
    if (sequence !== undefined) {
      received.delete(sequence)
    }
  }
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
  receiptProvider?: AgentSessionReceiptProvider
  pendingReceiptSequence?: (itemId: string) => number | undefined
}

export function createStructuredAgentSessionEventCoalescer(
  emit: (event: AgentSessionSubscribeEvent) => void,
  {
    ms: delayMs = STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS,
    visibility,
    receiptProvider,
    pendingReceiptSequence
  }: StructuredAgentSessionCoalescing = {}
): {
  push: (event: AgentSessionSubscribeEvent) => void
  flush: () => void
  dispose: () => void
  clearProviderReceived: () => void
} {
  const receiptLimit = receiptProvider ? AGENT_SESSION_DISPATCH_LIMITS[receiptProvider] : 0
  let pending: HeldBatches | null = null
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
  }
  const drawHeld = (): void => {
    visibility?.heldDrawn?.()
    flush()
  }
  const stopShownWatch = visibility?.subscribeShown(() => {
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
      if (event.type === 'batch' && isProviderReceiptOnly(event)) {
        if (pending) {
          const header = pending.merged ?? pending.first
          const { cursor } = header.batch
          if (
            event.fence === header.fence &&
            event.batch.cursor.epoch === cursor.epoch &&
            event.batch.cursor.sequence <= cursor.sequence
          ) {
            holdProviderReceived(pending, event, receiptLimit)
          }
        } else {
          emit(event)
        }
        return
      }
      if (pending && event.type === 'batch') {
        pruneHeldReceipts(pending, event, pendingReceiptSequence)
      }
      if (bypassCoalescing(event)) {
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
      if (pending) {
        addToHeld(pending, event)
      } else {
        pending = holdBatch(event)
      }
      holdProviderReceived(pending, event, receiptLimit)
      pruneHeldReceipts(pending, event, pendingReceiptSequence)
      // The host's newest text for a viewer that just showed: drawn at once, with what was held.
      if (awaitingTail) {
        drawHeld()
        return
      }
      timer ??= setTimeout(() => (visibility?.hidden() ? (timer = null) : flush()), delayMs)
    },
    flush,
    clearProviderReceived() {
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
    }
  }
}
