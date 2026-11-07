// The shared journal key's one writer: a batch of whole snapshots, identified and plain additions
// and discharges is coalesced against one read of the journal and written with at most one call.

import type { NativeChatComposerDraftAddition } from './native-chat-composer-draft-addition'
import { handbackReceiptKey } from './native-chat-composer-draft-custody'
import {
  MAX_JOURNAL_ADDITIONS_CHARS,
  MAX_JOURNAL_CHARS,
  THIS_RUN,
  identifiedJournalId,
  isAddition,
  journalEntryId,
  readNativeChatComposerDraftJournal,
  writeEncodedNativeChatComposerDraftJournal,
  type JournalEntry,
  type NativeChatDraftJournalCustody
} from './native-chat-composer-draft-journal'
import type { StoredNativeChatComposerDraft } from './native-chat-composer-draft-storage'

export type NativeChatDraftJournalAddition = {
  readonly scopeKey: string
  readonly addition: NativeChatComposerDraftAddition
  readonly at: number
  readonly custody?: NativeChatDraftJournalCustody
}

export type NativeChatDraftJournalBatch = {
  /** Whole snapshots (null: the draft's removal), within the whole-draft cap. Each may discharge
   *  identified additions of its scope (receipt keys), only if it is itself admitted. */
  readonly snapshots?: ReadonlyMap<
    string,
    {
      readonly draft: StoredNativeChatComposerDraft | null
      readonly at: number
      readonly discharge?: readonly string[]
    }
  >
  readonly additions?: readonly NativeChatDraftJournalAddition[]
  /** Scopes whose plain additions from this run one new addition of their whole unread-base input
   *  replaces, only if the write lands. */
  readonly superseded?: ReadonlySet<string>
  /** Identified additions to remove on their own, once a committed record carries them: [scopeKey, receipt key]. */
  readonly discharge?: readonly (readonly [string, string])[]
}

/** What the one write actually holds: only a successful (or unchanged) write is a witness. */
export type NativeChatDraftJournalWitness = {
  readonly written: boolean
  readonly snapshots: ReadonlySet<string>
  readonly additions: ReadonlySet<string>
}

const NONE: NativeChatDraftJournalWitness = {
  written: false,
  snapshots: new Set(),
  additions: new Set()
}

type Encoded = { readonly entry: JournalEntry; readonly text: string }

/** One encoding per entry; a kept entry is encoded as it was read, so its text stays exact. */
function encode(entry: JournalEntry, read: unknown = entry): Encoded {
  return { entry, text: JSON.stringify(read) }
}

/** One read/parse, one encoding per kept or new entry, one write. An entry is replaced only by
 *  an admitted replacement: a whole snapshot carrying (or discharging) a receipt removes that
 *  receipt's identified addition, and an admitted identified addition its older copy; whatever
 *  the caps omit leaves the copy it would have replaced. */
export function writeNativeChatComposerDraftJournalBatch(
  batch: NativeChatDraftJournalBatch
): NativeChatDraftJournalWitness {
  const snapshots = batch.snapshots ?? new Map()
  const additions = batch.additions ?? []
  if (!snapshots.size && !additions.length && !batch.discharge?.length && !batch.superseded?.size) {
    return NONE
  }
  const { raw, entries, read } = readNativeChatComposerDraftJournal()
  const existing = entries.map((entry, index) => encode(entry, read[index]))
  // Each identified addition's current copies, and the whole copies a scope's admitted snapshot
  // replaces that are charged now (kept if it is omitted), indexed once.
  const copies = new Map<string, Encoded[]>()
  // This run's plain additions of a scope whose whole unread-base input arrives as one addition.
  const earlier = new Map<string, Encoded[]>()
  const charged = new Map<string, number>()
  let used = 0
  for (const encoded of existing) {
    const { entry, text } = encoded
    const id = journalEntryId(entry)
    if (id) {
      const list = copies.get(id) ?? []
      list.push(encoded)
      copies.set(id, list)
    } else if (
      isAddition(entry) &&
      entry.run === THIS_RUN &&
      batch.superseded?.has(entry.scopeKey)
    ) {
      const list = earlier.get(entry.scopeKey) ?? []
      list.push(encoded)
      earlier.set(entry.scopeKey, list)
    }
    if (isAddition(entry) || !entry.draft) {
      continue
    }
    if (!snapshots.has(entry.scopeKey)) {
      used += text.length + 1
    } else if (entry.draft.handbacks?.length) {
      used += text.length + 1
      charged.set(entry.scopeKey, (charged.get(entry.scopeKey) ?? 0) + text.length + 1)
    }
  }
  const candidates = [...snapshots]
    .map(([scopeKey, { draft, at }]) => encode({ scopeKey, draft, at, run: THIS_RUN }))
    .sort((left, right) => left.text.length - right.text.length)
  const added: Encoded[] = []
  for (const candidate of candidates) {
    // An admitted snapshot replaces its scope's older whole copies: charged at its net size.
    const whole = !isAddition(candidate.entry) && Boolean(candidate.entry.draft)
    const next =
      used - (charged.get(candidate.entry.scopeKey) ?? 0) + (whole ? candidate.text.length + 1 : 0)
    if (whole && next > MAX_JOURNAL_CHARS) {
      continue
    }
    added.push(candidate)
    used = next
  }
  const replaced = new Set(added.map(({ entry }) => entry.scopeKey))
  const removedIds = new Set(
    batch.discharge?.map(([scope, key]) => identifiedJournalId(scope, key))
  )
  for (const { entry } of added) {
    if (!isAddition(entry)) {
      for (const key of [
        ...(entry.draft?.handbacks ?? []).map(handbackReceiptKey),
        ...(snapshots.get(entry.scopeKey)?.discharge ?? [])
      ]) {
        removedIds.add(identifiedJournalId(entry.scopeKey, key))
      }
    }
  }
  const incoming = additions.map((addition) =>
    encode({
      ...addition,
      run: THIS_RUN,
      ...(addition.custody ? { custody: addition.custody } : {})
    })
  )
  let additionChars = 0
  for (const { entry, text } of existing) {
    const id = journalEntryId(entry)
    if (isAddition(entry) && !(id && removedIds.has(id))) {
      additionChars += text.length + 1
    }
  }
  // A replacement is charged its net size and admitted before its old copies go.
  const keptAdditions: Encoded[] = []
  const written = new Set<string>()
  // A superseded scope's earlier additions go with the first new addition of that scope, which
  // carries its whole input, only if that one is admitted; with none (its input is now empty),
  // they simply go.
  const dropped = new Set(batch.superseded)
  const carried = new Set<string>()
  if (dropped.size) {
    for (const { entry } of incoming) {
      dropped.delete(entry.scopeKey)
    }
  }
  incoming.forEach((candidate, index) => {
    const id = journalEntryId(candidate.entry)
    const scopeKey = candidate.entry.scopeKey
    const carries = Boolean(batch.superseded?.has(scopeKey)) && !carried.has(scopeKey)
    carried.add(scopeKey)
    const old = [
      ...(id && !removedIds.has(id) ? (copies.get(id) ?? []) : []),
      ...(carries ? (earlier.get(scopeKey) ?? []) : [])
    ]
    const oldChars = old.reduce((sum, { text }) => sum + text.length + 1, 0)
    if (additionChars - oldChars + candidate.text.length + 1 > MAX_JOURNAL_ADDITIONS_CHARS) {
      return
    }
    keptAdditions.push(candidate)
    additionChars += candidate.text.length + 1 - oldChars
    if (id) {
      removedIds.add(id)
    }
    if (carries) {
      dropped.add(scopeKey)
    }
    written.add(id ?? `plain:${index}`)
  })
  // A capped-out snapshot leaves its scope's last receipt-bearing copy: it may be the only proof.
  const kept = existing.filter(({ entry }) => {
    const id = journalEntryId(entry)
    if (id) {
      return !removedIds.has(id)
    }
    if (isAddition(entry)) {
      return !(entry.run === THIS_RUN && dropped.has(entry.scopeKey))
    }
    return (
      !snapshots.has(entry.scopeKey) ||
      (!replaced.has(entry.scopeKey) && Boolean(entry.draft?.handbacks?.length))
    )
  })
  const pieces = [...kept, ...added, ...keptAdditions].map(({ text }) => text)
  if (!writeEncodedNativeChatComposerDraftJournal(raw, pieces)) {
    return NONE
  }
  return { written: true, snapshots: replaced, additions: written }
}

/** Journal additions immediately; false means they need storage confirmation before their source can be deleted. */
export function journalNativeChatComposerDraftAddition(
  scopeKey: string,
  addition: NativeChatComposerDraftAddition,
  at: number,
  custody?: NativeChatDraftJournalCustody
): boolean {
  const witness = writeNativeChatComposerDraftJournalBatch({
    additions: [{ scopeKey, addition, at, ...(custody ? { custody } : {}) }]
  })
  return witness.additions.has(
    custody ? identifiedJournalId(scopeKey, handbackReceiptKey(custody.handback)) : 'plain:0'
  )
}
