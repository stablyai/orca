import type { NativeChatMessage } from '../native-chat-types'
import type { NativeChatPendingSend } from './native-chat-pending-sends'
import {
  nativeChatReceiptSnapshot,
  nativeChatReceiptWindow,
  nativeChatSourceReceiptKey,
  type NativeChatReceiptDependency
} from './native-chat-source-receipts'
import {
  liveNativeChatReceiptDependencies,
  nativeChatReceiptDependencyKey,
  nativeChatPendingWitnesses,
  pendingReceiptBit,
  type NativeChatPendingWitness
} from './native-chat-pending-witnesses'

type Allocation = {
  represented: Set<string>
  advanced: Set<string>
  witnesses: NativeChatPendingWitness[]
}
const allocations = new WeakMap<
  readonly NativeChatPendingSend[],
  WeakMap<readonly NativeChatMessage[], { sessionId: string; result: Allocation }>
>()
type Choice = {
  mask: number
  requires: number
  witnesses: NativeChatPendingWitness[]
  rows: number[]
}

function earlier(left: Choice, right: Choice): boolean {
  for (let index = 0; index < left.rows.length; index++) {
    if (left.rows[index] !== right.rows[index]) {
      return left.rows[index] < right.rows[index]
    }
  }
  return false
}

/** Row-wise pending-mask feasibility avoids enumerating combinations of history rows. */
export function reconcileNativeChatPendingSends(
  pending: readonly NativeChatPendingSend[],
  messages: readonly NativeChatMessage[],
  sessionId: string
): Allocation {
  if (!pending.length) {
    return { represented: new Set(), advanced: new Set(), witnesses: [] }
  }
  let byMessages = allocations.get(pending)
  if (!byMessages) {
    allocations.set(pending, (byMessages = new WeakMap()))
  }
  const cached = byMessages.get(messages)
  if (cached?.sessionId === sessionId) {
    return cached.result
  }
  const snapshot = nativeChatReceiptSnapshot(messages)
  const locked = new Map<string, NativeChatPendingWitness>()
  for (const [index, entry] of pending.entries()) {
    if (entry.sourceReceipt?.sessionId !== sessionId) {
      continue
    }
    const key = nativeChatSourceReceiptKey(entry.sourceReceipt)
    let witness = locked.get(key)
    if (!witness) {
      const row = snapshot.rows.find((row) => row.message.id === entry.sourceReceipt!.id)
      // A paged-out unit remains owned; no replacement receipt may be allocated.
      witness = {
        row: row ?? {
          index: -1,
          message: {
            id: entry.sourceReceipt.id,
            role: 'user',
            source: 'transcript',
            blocks: [],
            timestamp: null
          }
        },
        mask: 0,
        requires: 0,
        members: [],
        proof: entry.receiptProof ?? 'source',
        glue: entry.receiptGlue,
        glueMembers: new Set<number>(),
        advanced: new Set()
      }
      locked.set(key, witness)
    }
    witness.members.push(index)
    if (entry.receiptGlue) {
      witness.glueMembers!.add(index)
    }
    witness.mask |= pendingReceiptBit(index, pending.length)
    const eligible = nativeChatReceiptWindow(entry, snapshot, sessionId, entry.receiptGlue)
    if (
      witness.row.index >= 0 &&
      snapshot.rows.some(
        (row) => row.index > witness.row.index && row.message.role !== 'user' && eligible(row)
      )
    ) {
      witness.advanced.add(entry.id)
    }
  }
  const initialMask = [...locked.values()].reduce((mask, witness) => mask | witness.mask, 0)
  const initial: Choice = {
    mask: initialMask,
    requires: 0,
    witnesses: [...locked.values()],
    rows: pending.map((entry) =>
      entry.sourceReceipt?.sessionId === sessionId
        ? (snapshot.boundaries.get(entry.sourceReceipt.id) ?? -1)
        : Infinity
    )
  }
  let states = new Map<string, Choice>([[`${initialMask}:0`, initial]])
  const byRow = new Map<number, NativeChatPendingWitness[]>()
  for (const witness of nativeChatPendingWitnesses(pending, snapshot, sessionId)) {
    const list = byRow.get(witness.row.index) ?? []
    list.push(witness)
    byRow.set(witness.row.index, list)
  }
  for (const [, witnesses] of [...byRow].sort(([a], [b]) => a - b)) {
    const next = new Map(states)
    for (const choice of states.values()) {
      for (const witness of witnesses) {
        if (choice.mask & witness.mask) {
          continue
        }
        const mask = choice.mask | witness.mask
        const requires = (choice.requires | witness.requires) & ~mask
        const rows = [...choice.rows]
        for (const index of witness.members) {
          rows[index] = witness.row.index
        }
        const candidate = { mask, requires, rows, witnesses: [...choice.witnesses, witness] }
        const key = `${mask}:${requires}`
        const previous = next.get(key)
        if (!previous || earlier(candidate, previous)) {
          next.set(key, candidate)
        }
      }
    }
    states = next
  }
  let best = initial
  for (const choice of states.values()) {
    if (
      choice.requires === 0 &&
      (choice.mask > best.mask || (choice.mask === best.mask && earlier(choice, best)))
    ) {
      best = choice
    }
  }
  const result = {
    witnesses: best.witnesses,
    represented: new Set(
      best.witnesses.flatMap((witness) => witness.members.map((index) => pending[index].id))
    ),
    advanced: new Set(best.witnesses.flatMap((witness) => [...witness.advanced]))
  }
  byMessages.set(messages, { sessionId, result })
  return result
}

export function commitNativeChatPendingReceipts<T extends NativeChatPendingSend>(
  pending: T[],
  messages: readonly NativeChatMessage[],
  sessionId: string
): T[] {
  if (!pending.length) {
    return pending
  }
  const result = reconcileNativeChatPendingSends(pending, messages, sessionId)
  const survivors = pending.filter((entry) => !result.advanced.has(entry.id))
  const assigned = new Map(
    result.witnesses.flatMap((witness) =>
      witness.members.map((index) => [pending[index].id, witness] as const)
    )
  )
  const spent = new Set(
    result.witnesses
      .filter((witness) => witness.members.every((index) => result.advanced.has(pending[index].id)))
      .map((witness) => witness.row.message.id)
  )
  const dependencies = new Map(
    liveNativeChatReceiptDependencies(survivors).map((dependency) => [
      nativeChatReceiptDependencyKey(dependency),
      dependency
    ])
  )
  if (spent.size) {
    const unowned = survivors.filter(
      (entry) => !assigned.has(entry.id) && entry.sourceReceipt?.sessionId !== sessionId
    )
    for (const witness of nativeChatPendingWitnesses(
      unowned,
      nativeChatReceiptSnapshot(messages),
      sessionId,
      { prospective: true, onlyRows: spent }
    )) {
      const dependency: NativeChatReceiptDependency = {
        receipt: { sessionId, id: witness.row.message.id },
        members: witness.members.map((index) => unowned[index].id),
        proof: witness.proof
      }
      dependencies.set(nativeChatReceiptDependencyKey(dependency), dependency)
    }
  }
  let changed = survivors.length !== pending.length
  const next = survivors.map((entry) => {
    const witness = assigned.get(entry.id)
    const receipt = witness ? { sessionId, id: witness.row.message.id } : entry.sourceReceipt
    const receiptMembers = witness
      ? (entry.receiptMembers ?? witness.members.map((index) => pending[index].id))
      : entry.receiptMembers
    const receiptProof = witness?.proof ?? entry.receiptProof
    const applicable = witness
      ? []
      : [...dependencies.values()].filter((dependency) => dependency.members.includes(entry.id))
    if (
      receipt?.id === entry.sourceReceipt?.id &&
      receipt?.sessionId === entry.sourceReceipt?.sessionId &&
      applicable.length === (entry.receiptDependencies?.length ?? 0) &&
      applicable.every((dependency, index) => dependency === entry.receiptDependencies?.[index])
    ) {
      return entry
    }
    changed = true
    return {
      ...entry,
      sourceReceipt: receipt,
      receiptMembers,
      receiptProof,
      receiptGlue: witness
        ? (witness.glueMembers?.has(pending.indexOf(entry)) ?? witness.glue)
        : entry.receiptGlue,
      receiptDependencies: applicable.length ? applicable : undefined
    }
  })
  return changed ? next : pending
}
