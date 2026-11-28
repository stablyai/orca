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
}

function holdBatch(event: Batch): HeldBatches {
  return {
    first: event,
    merged: null,
    items: new Map(event.batch.items.map((item) => [item.itemId, item])),
    submissions: new Map(
      event.batch.submissions.map((submission) => [submission.clientMessageId, submission])
    )
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
  held.merged = mergeBatchHeader(held.merged ?? held.first, right)
}

function heldEvent(held: HeldBatches): Batch {
  if (!held.merged) {
    return held.first
  }
  return {
    ...held.merged,
    batch: {
      ...held.merged.batch,
      items: [...held.items.values()],
      submissions: [...held.submissions.values()]
    }
  }
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
}

export function createStructuredAgentSessionEventCoalescer(
  emit: (event: AgentSessionSubscribeEvent) => void,
  {
    ms: delayMs = STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS,
    visibility
  }: StructuredAgentSessionCoalescing = {}
): {
  push: (event: AgentSessionSubscribeEvent) => void
  flush: () => void
  dispose: () => void
} {
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
      // The host's newest text for a viewer that just showed: drawn at once, with what was held.
      if (awaitingTail) {
        drawHeld()
        return
      }
      timer ??= setTimeout(() => (visibility?.hidden() ? (timer = null) : flush()), delayMs)
    },
    flush,
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
