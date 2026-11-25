import { structuredAgentSessionSendingMembers } from './structured-agent-session-sending'
import {
  changedSubmissionReceiptIds,
  type StructuredAgentSubmission,
  type SubmissionReceipts
} from './structured-agent-session-submissions'

export type SubmissionReceiptSource = {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => SubmissionReceipts
}

type Listener = () => void
type Gate = {
  shown: ReadonlySet<string>
  count: number
  pending: boolean
  listeners: Set<Listener>
}

export function createStructuredAgentSendingSource(
  receipts: SubmissionReceiptSource,
  pending: Parameters<typeof structuredAgentSessionSendingMembers>[0],
  submissions: readonly StructuredAgentSubmission[]
) {
  const members = structuredAgentSessionSendingMembers(pending, submissions)
  const candidates = new Set(members.values())
  const sending = new Set<string>()
  const leaves = new Map<string, Set<Listener>>()
  const gates = new Set<Gate>()
  let previous: SubmissionReceipts | undefined
  let unsubscribe: (() => void) | undefined

  function sync(): void {
    const current = receipts.getSnapshot()
    if (previous === current) {
      return
    }
    const changed = previous && changedSubmissionReceiptIds(previous, current)
    previous = current
    const notify: Listener[] = []
    for (const id of changed ?? members.keys()) {
      const item = members.get(id)
      if (item === undefined) {
        continue
      }
      const next = current.get(id) === undefined
      if (sending.has(item) === next) {
        continue
      }
      if (next) {
        sending.add(item)
      } else {
        sending.delete(item)
      }
      for (const gate of gates) {
        if (gate.shown.has(item)) {
          gate.count += next ? 1 : -1
        }
      }
      const listeners = leaves.get(item)
      if (listeners) {
        notify.push(...listeners)
      }
    }
    for (const gate of gates) {
      const pending = gate.count > 0
      if (gate.pending !== pending) {
        gate.pending = pending
        notify.push(...gate.listeners)
      }
    }
    notify.forEach((listener) => listener())
  }

  function leave(): void {
    if (leaves.size === 0 && gates.size === 0) {
      unsubscribe?.()
      unsubscribe = undefined
    }
  }

  function count(shown: ReadonlySet<string>): number {
    let total = 0
    for (const item of sending) {
      if (shown.has(item)) {
        total++
      }
    }
    return total
  }

  return {
    candidates,
    getId(id: string) {
      if (!unsubscribe) {
        sync()
      }
      return sending.has(id)
    },
    subscribeId(id: string, listener: Listener) {
      const listeners = leaves.get(id) ?? new Set()
      leaves.set(id, listeners)
      listeners.add(listener)
      unsubscribe ??= receipts.subscribe(sync)
      sync()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          leaves.delete(id)
          leave()
        }
      }
    },
    gateFor(shown: ReadonlySet<string>) {
      const gate: Gate = { shown, count: 0, pending: false, listeners: new Set() }
      let observed: SubmissionReceipts | undefined
      const read = () => {
        if (!unsubscribe) {
          sync()
        }
        if (gate.listeners.size === 0 && observed !== previous) {
          gate.count = count(shown)
          gate.pending = gate.count > 0
          observed = previous
        }
        return gate.pending
      }
      return {
        getSnapshot: read,
        subscribe(listener: Listener) {
          if (gate.listeners.size === 0) {
            read()
            gates.add(gate)
          }
          gate.listeners.add(listener)
          unsubscribe ??= receipts.subscribe(sync)
          sync()
          return () => {
            gate.listeners.delete(listener)
            if (gate.listeners.size === 0) {
              observed = previous
              gates.delete(gate)
              leave()
            }
          }
        }
      }
    }
  }
}

export type StructuredAgentSendingSource = ReturnType<typeof createStructuredAgentSendingSource>
