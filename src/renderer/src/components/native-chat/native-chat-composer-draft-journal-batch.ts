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
  /** Whole snapshots (null: the draft's removal), within the whole-draft cap. */
  readonly snapshots?: ReadonlyMap<
    string,
    { readonly draft: StoredNativeChatComposerDraft | null; readonly at: number }
  >
  readonly additions?: readonly NativeChatDraftJournalAddition[]
  /** Identified additions to remove: [scopeKey, receipt key]. */
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

function encode(entry: JournalEntry): Encoded {
  return { entry, text: JSON.stringify(entry) }
}

/** One read/parse, one encoding per kept or new entry, one write. A whole snapshot carrying a
 *  receipt replaces that receipt's identified addition in the same write. */
export function writeNativeChatComposerDraftJournalBatch(
  batch: NativeChatDraftJournalBatch
): NativeChatDraftJournalWitness {
  const snapshots = batch.snapshots ?? new Map()
  const additions = batch.additions ?? []
  if (!snapshots.size && !additions.length && !batch.discharge?.length) {
    return NONE
  }
  const { raw, entries } = readNativeChatComposerDraftJournal()
  const existing = entries.map(encode)
  let used = 0
  for (const { entry, text } of existing) {
    if (
      !isAddition(entry) &&
      entry.draft &&
      (!snapshots.has(entry.scopeKey) || entry.draft.handbacks?.length)
    ) {
      used += text.length + 1
    }
  }
  const candidates = [...snapshots]
    .map(([scopeKey, { draft, at }]) => encode({ scopeKey, draft, at, run: THIS_RUN }))
    .sort((left, right) => left.text.length - right.text.length)
  const added: Encoded[] = []
  for (const candidate of candidates) {
    const size = candidate.text.length + 1
    if (!isAddition(candidate.entry) && candidate.entry.draft && used + size > MAX_JOURNAL_CHARS) {
      continue
    }
    added.push(candidate)
    if (!isAddition(candidate.entry) && candidate.entry.draft) {
      used += size
    }
  }
  const replaced = new Set(added.map(({ entry }) => entry.scopeKey))
  const removedIds = new Set(
    batch.discharge?.map(([scope, key]) => identifiedJournalId(scope, key))
  )
  for (const { entry } of added) {
    if (!isAddition(entry)) {
      for (const receipt of entry.draft?.handbacks ?? []) {
        removedIds.add(identifiedJournalId(entry.scopeKey, handbackReceiptKey(receipt)))
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
  incoming.forEach(({ entry }) => {
    const id = journalEntryId(entry)
    if (id) {
      removedIds.add(id)
    }
  })
  // A capped-out snapshot leaves its scope's last receipt-bearing copy: it may be the only proof.
  const kept = existing.filter(({ entry }) => {
    const id = journalEntryId(entry)
    if (id) {
      return !removedIds.has(id)
    }
    return (
      isAddition(entry) ||
      !snapshots.has(entry.scopeKey) ||
      (!replaced.has(entry.scopeKey) && Boolean(entry.draft?.handbacks?.length))
    )
  })
  let additionChars = 0
  for (const { entry, text } of kept) {
    if (isAddition(entry)) {
      additionChars += text.length + 1
    }
  }
  const keptAdditions: Encoded[] = []
  const written = new Set<string>()
  incoming.forEach((candidate, index) => {
    if (additionChars + candidate.text.length + 1 <= MAX_JOURNAL_ADDITIONS_CHARS) {
      keptAdditions.push(candidate)
      additionChars += candidate.text.length + 1
      written.add(journalEntryId(candidate.entry) ?? `plain:${index}`)
    }
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
