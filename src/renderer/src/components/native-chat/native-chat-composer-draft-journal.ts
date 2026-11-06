// Journal unconfirmed drafts synchronously on unload; journal returned additions immediately because crashes skip unload and their source is deleted.

import {
  withNativeChatComposerDraftAddition,
  type NativeChatComposerDraftAddition
} from './native-chat-composer-draft-addition'
import {
  parseHandbackReceipt,
  parseStoredNativeChatComposerDraft,
  type NativeChatDraftHandbackReceipt,
  type StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'
import {
  finishStoredNativeChatDraft,
  handbackReceiptKey,
  hasHandbackReceipt,
  withHandbackReceipts,
  withIdentifiedHandback
} from './native-chat-composer-draft-custody'

export const JOURNAL_KEY = 'orca:nativeChatComposerDraftJournal:v1'
// Cap whole drafts and additions separately to protect localStorage quota; always retain tiny removal entries to prevent sent drafts returning.
export const MAX_JOURNAL_CHARS = 256_000
export const MAX_JOURNAL_ADDITIONS_CHARS = 800_000

// Replay only earlier runs’ entries; this run already holds its own changes in memory.
export let THIS_RUN = `${Date.now()}-${Math.random()}`

/** A test's cold reload is a new run: this run's entries become the earlier run's to replay. */
export function startNativeChatComposerDraftJournalRunForTests(): void {
  THIS_RUN = `${Date.now()}-${Math.random()}`
}

export type EntryBase = { readonly scopeKey: string; readonly at: number; readonly run?: string }
export type DraftEntry = EntryBase & { readonly draft: StoredNativeChatComposerDraft | null }
/** An identified hand-back: applied once as an independent contribution, with its receipt. */
export type NativeChatDraftJournalCustody = {
  readonly handback: NativeChatDraftHandbackReceipt
  readonly sourcePaths?: readonly string[]
}
export type AdditionEntry = EntryBase & {
  readonly addition: NativeChatComposerDraftAddition
  readonly custody?: NativeChatDraftJournalCustody
}
export type JournalEntry = DraftEntry | AdditionEntry

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isAddition(entry: JournalEntry): entry is AdditionEntry {
  return 'addition' in entry
}

export function parseEntry(entry: unknown): JournalEntry[] {
  if (!isRecord(entry)) {
    return []
  }
  const { scopeKey, draft, at, addition } = entry
  if (typeof scopeKey !== 'string' || typeof at !== 'number') {
    return []
  }
  const run = typeof entry.run === 'string' ? entry.run : undefined
  if (!isRecord(addition)) {
    return [{ scopeKey, draft: parseStoredNativeChatComposerDraft(draft), at, run }]
  }
  const parsed = parseStoredNativeChatComposerDraft({
    text: typeof addition.text === 'string' ? addition.text : '',
    document: addition.document,
    pastedTextFiles: addition.pastedTextFiles,
    images: Array.isArray(addition.images) ? addition.images : [],
    savedAt: at
  })
  const handback = isRecord(entry.custody) ? parseHandbackReceipt(entry.custody.handback) : null
  const sourcePaths =
    isRecord(entry.custody) && Array.isArray(entry.custody.sourcePaths)
      ? entry.custody.sourcePaths.filter((path): path is string => typeof path === 'string')
      : []
  return parsed
    ? [
        {
          scopeKey,
          at,
          run,
          ...(handback ? { custody: { handback, sourcePaths } } : {}),
          addition: {
            text: parsed.text,
            images: parsed.images,
            document: parsed.document,
            pastedTextFiles: parsed.pastedTextFiles,
            ...(addition.fromUser === true ? { fromUser: true } : {}),
            ...(typeof addition.before === 'string' ? { before: addition.before } : {}),
            ...(Array.isArray(addition.fills)
              ? { fills: addition.fills.filter((id) => typeof id === 'string') }
              : {})
          }
        }
      ]
    : []
}

/** The one read of the shared journal: its raw text (for an unchanged-output check), its entries,
 *  and each entry as it was read, so a writer keeping it keeps its exact text. */
export function readNativeChatComposerDraftJournal(): {
  raw: string | null
  entries: JournalEntry[]
  read: unknown[]
} {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY)
    const parsed: unknown = raw === null ? [] : JSON.parse(raw)
    const entries: JournalEntry[] = []
    const read: unknown[] = []
    for (const value of Array.isArray(parsed) ? parsed : []) {
      const entry = parseEntry(value)[0]
      if (entry) {
        entries.push(entry)
        read.push(value)
      }
    }
    return { raw, entries, read }
  } catch {
    return { raw: null, entries: [], read: [] }
  }
}

export function identifiedJournalId(scopeKey: string, receiptKey: string): string {
  return JSON.stringify([scopeKey, receiptKey])
}

export function journalEntryId(entry: JournalEntry): string | null {
  return isAddition(entry) && entry.custody
    ? identifiedJournalId(entry.scopeKey, handbackReceiptKey(entry.custody.handback))
    : null
}

/** One shared-key mutation from already-encoded entries; unchanged output writes nothing. */
export function writeEncodedNativeChatComposerDraftJournal(
  raw: string | null,
  pieces: readonly string[]
): boolean {
  const output = pieces.length ? `[${pieces.join(',')}]` : null
  if (output === raw) {
    return true
  }
  try {
    if (output === null) {
      localStorage.removeItem(JOURNAL_KEY)
    } else {
      localStorage.setItem(JOURNAL_KEY, output)
    }
    return true
  } catch {
    // A full localStorage loses only what storage itself had not yet confirmed.
    return false
  }
}

export type NativeChatComposerDraftJournalSnapshot = readonly JournalEntry[]

let replaySnapshot: ReadonlyMap<string, readonly JournalEntry[]> | null = null

/** Earlier runs' entries, read once at a load attempt's read boundary and indexed by scope; every
 *  scope's own base read in that attempt consumes this same snapshot. */
export function captureNativeChatComposerDraftReplaySnapshot(): NativeChatComposerDraftJournalSnapshot {
  const entries = readNativeChatComposerDraftJournal().entries.filter(
    (entry) => entry.run !== THIS_RUN
  )
  const index = new Map<string, JournalEntry[]>()
  for (const entry of entries) {
    const scoped = index.get(entry.scopeKey) ?? []
    index.set(entry.scopeKey, scoped)
    scoped.push(entry)
  }
  replaySnapshot = index
  return entries
}

export function nativeChatComposerDraftReplayEntries(
  scopeKey: string
): NativeChatComposerDraftJournalSnapshot {
  if (!replaySnapshot) {
    captureNativeChatComposerDraftReplaySnapshot()
  }
  return replaySnapshot?.get(scopeKey) ?? []
}

/** The attempt ended (or a new one begins): its snapshot is no longer the journal to replay. */
export function releaseNativeChatComposerDraftReplaySnapshot(): void {
  replaySnapshot = null
}

/** Replay newer drafts and additions once, return changed drafts for persistence, and discard
 *  entries older than storage. `drafts` starts as what storage committed; a newer ordinary
 *  snapshot, a removal included, replaces content but keeps committed receipts it never saw. */
export function replayNativeChatComposerDraftJournal(
  drafts: Map<string, StoredNativeChatComposerDraft | null>,
  entries: NativeChatComposerDraftJournalSnapshot,
  /** Per scope, the identified additions the replayed drafts now carry. */
  materialized?: Map<string, Set<string>>
): Set<string> {
  const committed = new Map(drafts)
  const changed = new Set<string>()
  const removedAt = new Map<string, number>()
  const stale: { scopeKey: string; at: number; identified: boolean }[] = []
  for (const entry of entries) {
    if (isAddition(entry)) {
      continue
    }
    const stored = drafts.get(entry.scopeKey)
    if (stored && stored.savedAt >= entry.at) {
      stale.push({ scopeKey: entry.scopeKey, at: entry.at, identified: false })
      continue
    }
    const base = committed.get(entry.scopeKey)
    const kept = base?.handbacks ?? []
    drafts.set(
      entry.scopeKey,
      !kept.length
        ? entry.draft
        : entry.draft
          ? { ...entry.draft, handbacks: withHandbackReceipts(entry.draft.handbacks, kept) }
          : finishStoredNativeChatDraft(null, {
              handbacks: kept,
              owner: base?.owner,
              savedAt: entry.at
            })
    )
    if (!entry.draft) {
      removedAt.set(entry.scopeKey, entry.at)
    }
    changed.add(entry.scopeKey)
  }
  const additions = entries.filter(isAddition).sort((left, right) => left.at - right.at)
  for (const { scopeKey, at, addition, custody } of additions) {
    const base = drafts.get(scopeKey) ?? null
    // An identified addition is judged by its receipt, never by a newer timestamp alone.
    const removed = (removedAt.get(scopeKey) ?? 0) >= at
    if (!custody && (base?.savedAt ?? removedAt.get(scopeKey) ?? 0) >= at) {
      stale.push({ scopeKey, at, identified: false })
      continue
    }
    if (custody) {
      const scoped = materialized?.get(scopeKey) ?? new Set<string>()
      materialized?.set(scopeKey, scoped.add(handbackReceiptKey(custody.handback)))
    }
    if (custody && removed) {
      // Cleared after it arrived: its content goes with that removal, its identity stays owed.
      if (!hasHandbackReceipt(base?.handbacks, custody.handback)) {
        drafts.set(
          scopeKey,
          finishStoredNativeChatDraft(base, {
            handbacks: withHandbackReceipts(base?.handbacks, [custody.handback]),
            sourcePaths: base?.sourcePaths,
            owner: base?.owner,
            savedAt: Math.max(base?.savedAt ?? 0, removedAt.get(scopeKey) ?? 0)
          })
        )
        changed.add(scopeKey)
      }
      continue
    }
    const from = base ?? { text: '', images: [], savedAt: 0 }
    const next = custody
      ? withIdentifiedHandback(from, {
          receipt: custody.handback,
          contribution: { ...addition, images: addition.images ?? [], text: addition.text ?? '' },
          sourcePaths: custody.sourcePaths ?? []
        })
      : { ...from, ...withNativeChatComposerDraftAddition(from, addition) }
    if (next !== from) {
      drafts.set(scopeKey, { ...next, savedAt: Math.max(at, from.savedAt) })
      changed.add(scopeKey)
    }
  }
  pruneStaleNativeChatComposerDraftJournal(stale)
  return changed
}

/** Entries storage already superseded, removed in one shared-key write. */
function pruneStaleNativeChatComposerDraftJournal(
  stale: readonly { scopeKey: string; at: number; identified: boolean }[]
): void {
  if (!stale.length) {
    return
  }
  const { raw, entries } = readNativeChatComposerDraftJournal()
  const superseded = (entry: JournalEntry) =>
    stale.some(
      (old) =>
        old.scopeKey === entry.scopeKey &&
        entry.at <= old.at &&
        (!isAddition(entry) || !entry.custody || old.identified)
    )
  writeEncodedNativeChatComposerDraftJournal(
    raw,
    entries.filter((entry) => !superseded(entry)).map((entry) => JSON.stringify(entry))
  )
}

/** Any window’s newer confirmed write prunes older entries so replay cannot resurrect sent or
 *  replaced drafts; identified additions go only by identity, or with a removal of the draft. */
export function pruneNativeChatComposerDraftJournal(
  scopeKey: string,
  confirmedAt: number,
  identified = false,
  handbacks: readonly string[] = []
): void {
  const { raw, entries } = readNativeChatComposerDraftJournal()
  if (raw === null) {
    return
  }
  const kept = entries.filter((entry) =>
    entry.scopeKey !== scopeKey
      ? true
      : isAddition(entry) && entry.custody
        ? !(identified && entry.at <= confirmedAt) &&
          !handbacks.includes(handbackReceiptKey(entry.custody.handback))
        : entry.at > confirmedAt
  )
  if (kept.length !== entries.length) {
    writeEncodedNativeChatComposerDraftJournal(
      raw,
      kept.map((entry) => JSON.stringify(entry))
    )
  }
}
