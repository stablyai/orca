import type { AgentSessionSubscribeEvent } from '../../agent-session-wire'
import { agentJournalSubmissionKey } from '../../journal/agent-session-journal-item-key'
import {
  AGENT_SESSION_DISPATCH_LIMITS,
  type AgentSessionReceiptProvider
} from '../../journal/agent-session-dispatch-limits'
import type { StructuredAgentSessionState } from './structured-agent-session-reducer'

export function isProviderReceiptOnly(event: AgentSessionSubscribeEvent): boolean {
  return (
    event.type === 'batch' &&
    !!event.providerReceived?.length &&
    !event.batch.items.length &&
    !event.batch.removedItemIds.length &&
    !event.batch.submissions.length &&
    event.commands === undefined &&
    event.commandsChanged === undefined &&
    event.currentRequests === undefined &&
    event.queuedMessages === undefined &&
    event.queuePause === undefined &&
    event.nextQueuedMessageId === undefined &&
    event.backgroundTasks === undefined &&
    event.activity === undefined &&
    event.promptSuggestion === undefined &&
    event.latestTurn === undefined &&
    event.actionablePromptIds === undefined &&
    event.working === undefined &&
    event.hasNewer === undefined
  )
}

export function createProviderReceivedStore() {
  const bySequence = new Map<number, string>()
  const pending = new Map<string, number>()
  const received = new Map<string, AgentSessionReceiptProvider>()
  const listeners = new Map<string, Set<() => void>>()
  const notify = (id: string) => listeners.get(id)?.forEach((listener) => listener())
  const remove = (id: string) => {
    const sequence = pending.get(id)
    if (sequence !== undefined) {
      bySequence.delete(sequence)
      pending.delete(id)
    }
    if (received.delete(id)) {
      notify(id)
    }
  }
  const trim = (floor: number) => {
    for (const [id, sequence] of pending) {
      if (sequence < floor) {
        remove(id)
      }
    }
  }
  const clear = () => {
    for (const id of pending.keys()) {
      remove(id)
    }
  }
  return {
    clear,
    trim: (items: StructuredAgentSessionState['items']) => {
      if (pending.size) {
        trim(items[0]?.sequence ?? Infinity)
      }
    },
    sequence: (id: string) => pending.get(id),
    provider: (id: string) => received.get(id),
    subscribe: (id: string, listener: () => void) => {
      const row = listeners.get(id) ?? new Set()
      row.add(listener)
      listeners.set(id, row)
      return () => {
        row.delete(listener)
        if (!row.size) {
          listeners.delete(id)
        }
      }
    },
    apply(
      event: AgentSessionSubscribeEvent,
      before: StructuredAgentSessionState,
      after: StructuredAgentSessionState,
      provider: AgentSessionReceiptProvider,
      opensSubscription?: boolean
    ) {
      if (event.type === 'end') {
        return
      }
      if (event.type !== 'batch' || opensSubscription || before.fence !== after.fence) {
        clear()
      }
      if (
        event.type !== 'batch' ||
        after.cursor?.epoch !== event.batch.cursor.epoch ||
        after.cursor.sequence !== event.batch.cursor.sequence
      ) {
        return
      }
      const limit = AGENT_SESSION_DISPATCH_LIMITS[provider]
      let handedOver: Set<string> | undefined
      for (const submission of event.batch.submissions) {
        const id = agentJournalSubmissionKey(submission.clientMessageId)
        if (submission.dispatchState !== 'pending') {
          remove(id)
        } else if (submission.handedOverAt !== undefined) {
          handedOver ??= new Set()
          handedOver.add(id)
        }
      }
      const floor = event.batch.items.length ? (after.items[0]?.sequence ?? Infinity) : undefined
      if (floor !== undefined && pending.size && after.items[0] !== before.items[0]) {
        trim(floor)
      }
      for (const item of event.batch.items) {
        const { itemId, sequence } = item
        const prior = pending.get(itemId)
        if ((floor !== undefined && sequence < floor) || prior === sequence) {
          continue
        }
        if (prior !== undefined) {
          remove(itemId)
        }
        if (
          handedOver?.has(itemId) &&
          pending.size < limit &&
          item.body.kind === 'message' &&
          item.body.role === 'user'
        ) {
          pending.set(itemId, sequence)
          bySequence.set(sequence, itemId)
        }
      }
      for (const id of event.batch.removedItemIds) {
        remove(id)
      }
      if (opensSubscription || (event.fence !== undefined && before.fence !== event.fence)) {
        return
      }
      const stamps = event.providerReceived
      for (let index = 0; stamps && index < Math.min(stamps.length, limit); index++) {
        const sequence = stamps[index]!
        const id = bySequence.get(sequence)
        if (id && !received.has(id)) {
          received.set(id, provider)
          notify(id)
        }
      }
    }
  }
}

export type ProviderReceivedStore = ReturnType<typeof createProviderReceivedStore>

export type ProviderReceivedLabels = Pick<ProviderReceivedStore, 'provider'> & {
  subscribe: (id: string, listener: () => void, agent: AgentSessionReceiptProvider) => () => void
}

/** A local stream may be shared by views that never mount a delivery label. */
export function createProviderReceivedLabels() {
  let store: ProviderReceivedStore | undefined
  let agent: AgentSessionReceiptProvider | undefined
  let mountedLabels = 0
  const labels: ProviderReceivedLabels = {
    provider: (id) => store?.provider(id),
    subscribe(id, listener, provider) {
      agent = provider
      const unsubscribe = (store ??= createProviderReceivedStore()).subscribe(id, listener)
      mountedLabels++
      return () => {
        unsubscribe()
        if (--mountedLabels === 0) {
          store = undefined
        }
      }
    }
  }
  return {
    labels,
    receiptLimit: () => (agent && store ? AGENT_SESSION_DISPATCH_LIMITS[agent] : 0),
    pendingReceiptSequence: (id: string) => store?.sequence(id),
    clearProviderReceived: () => store?.clear(),
    trim: (items: StructuredAgentSessionState['items']) => store?.trim(items),
    apply(
      event: AgentSessionSubscribeEvent,
      before: StructuredAgentSessionState,
      after: StructuredAgentSessionState,
      opensSubscription?: boolean
    ) {
      if (agent) {
        store?.apply(event, before, after, agent, opensSubscription)
      }
    }
  }
}

type Batch = Extract<AgentSessionSubscribeEvent, { type: 'batch' }>
export type ReceiptBatch = {
  first: Batch
  merged: Batch | null
  items: Map<string, Batch['batch']['items'][number]>
  providerReceived?: Set<number>
}

export function holdProviderReceived(held: ReceiptBatch, event: Batch, limit: number): void {
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

export function pruneHeldReceipts(
  held: ReceiptBatch,
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
