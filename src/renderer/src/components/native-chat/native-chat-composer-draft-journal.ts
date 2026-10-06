// The unload journal: changes storage had not confirmed when a window went away, written
// synchronously to localStorage and replayed by the next load. Every window of the app shares it,
// so each entry is pruned the moment any window confirms a change to that draft.
//
// Two kinds of entry: a whole draft (or its removal) journaled when the window goes away, and an
// addition (text or images given back) journaled the moment it is made, because the copy it came
// from is deleted right after and a crash fires no unload event.

import type { UnconfirmedDraftChange } from './native-chat-composer-draft-memory'
import {
  withNativeChatComposerDraftAddition,
  type NativeChatComposerDraftAddition
} from './native-chat-composer-draft-addition'
import {
  parseStoredNativeChatComposerDraft,
  type StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

const JOURNAL_KEY = 'orca:nativeChatComposerDraftJournal:v1'
// Why: localStorage also holds the send outbox, and a send is refused when its entry can't be
// saved, so the journal stays small: whole drafts together stop at the first cap, and additions,
// at most one message each with their source deleted right after, at the second, which fits the
// largest. A removal is never capped: it is tiny, and it is what keeps a sent draft from coming
// back.
export const MAX_JOURNAL_CHARS = 256_000
export const MAX_JOURNAL_ADDITIONS_CHARS = 800_000

// Why: a load replays only what earlier runs left, never this run's own entries, which its
// memory already holds.
const THIS_RUN = `${Date.now()}-${Math.random()}`

type EntryBase = { readonly scopeKey: string; readonly at: number; readonly run?: string }
type DraftEntry = EntryBase & { readonly draft: StoredNativeChatComposerDraft | null }
type AdditionEntry = EntryBase & { readonly addition: NativeChatComposerDraftAddition }
type JournalEntry = DraftEntry | AdditionEntry

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAddition(entry: JournalEntry): entry is AdditionEntry {
  return 'addition' in entry
}

function parseEntry(entry: unknown): JournalEntry[] {
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
  // Parsed as a draft, so its text and images are checked the same way.
  const parsed = parseStoredNativeChatComposerDraft({
    text: typeof addition.text === 'string' ? addition.text : '',
    images: Array.isArray(addition.images) ? addition.images : [],
    savedAt: at
  })
  return parsed
    ? [
        {
          scopeKey,
          at,
          run,
          addition: {
            text: parsed.text,
            images: parsed.images,
            ...(addition.fromUser === true ? { fromUser: true } : {})
          }
        }
      ]
    : []
}

function readEntries(): JournalEntry[] {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY)
    const entries: unknown = raw === null ? [] : JSON.parse(raw)
    return Array.isArray(entries) ? entries.flatMap(parseEntry) : []
  } catch {
    return []
  }
}

function writeEntries(entries: readonly JournalEntry[]): boolean {
  try {
    if (entries.length === 0) {
      localStorage.removeItem(JOURNAL_KEY)
    } else {
      localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries))
    }
    return true
  } catch {
    // A full localStorage loses only what storage itself had not yet confirmed.
    return false
  }
}

export type NativeChatComposerDraftJournalSnapshot = readonly JournalEntry[]

/** Other runs' entries as a load begins reading storage. Why then: an entry journaled later is a
 *  live window's, whose own write is ordered after this read and must not be overwritten by it. */
export function snapshotNativeChatComposerDraftJournal(): NativeChatComposerDraftJournalSnapshot {
  return readEntries().filter((entry) => entry.run !== THIS_RUN)
}

/**
 * Replays a snapshot onto the loaded drafts: a whole draft newer than the stored one replaces it,
 * then each addition newer than the draft it meets is made again, once. Returns the drafts it
 * changed, which must be written; entries already older than storage are dropped.
 */
export function replayNativeChatComposerDraftJournal(
  drafts: Map<string, StoredNativeChatComposerDraft | null>,
  entries: NativeChatComposerDraftJournalSnapshot
): Set<string> {
  const changed = new Set<string>()
  const removedAt = new Map<string, number>()
  for (const entry of entries) {
    if (isAddition(entry)) {
      continue
    }
    const stored = drafts.get(entry.scopeKey)
    if (stored && stored.savedAt >= entry.at) {
      pruneNativeChatComposerDraftJournal(entry.scopeKey, entry.at)
      continue
    }
    drafts.set(entry.scopeKey, entry.draft)
    if (!entry.draft) {
      removedAt.set(entry.scopeKey, entry.at)
    }
    changed.add(entry.scopeKey)
  }
  const additions = entries.filter(isAddition).sort((left, right) => left.at - right.at)
  for (const { scopeKey, at, addition } of additions) {
    const base = drafts.get(scopeKey) ?? null
    if ((base?.savedAt ?? removedAt.get(scopeKey) ?? 0) >= at) {
      pruneNativeChatComposerDraftJournal(scopeKey, at)
      continue
    }
    const from = base ?? { text: '', images: [], savedAt: 0 }
    const next = withNativeChatComposerDraftAddition(from, addition, { once: true })
    drafts.set(scopeKey, {
      ...from,
      ...next,
      ...(next.text === from.text ? {} : { document: undefined }),
      savedAt: at
    })
    changed.add(scopeKey)
  }
  return changed
}

/** Adds this window's unconfirmed changes, keeping other entries, with whole drafts within the
 *  cap. A draft that doesn't fit is left out; its change was still issued to storage. */
export function journalNativeChatComposerDraftChanges(
  changes: ReadonlyMap<string, UnconfirmedDraftChange>
): void {
  if (changes.size === 0) {
    return
  }
  const kept = readEntries().filter((entry) => isAddition(entry) || !changes.has(entry.scopeKey))
  let used = JSON.stringify(kept.filter((entry) => !isAddition(entry) && entry.draft)).length
  const added: JournalEntry[] = []
  const bySize = [...changes]
    .map(([scopeKey, change]) => ({ scopeKey, ...change, run: THIS_RUN }))
    .map((entry) => ({ entry, size: JSON.stringify(entry).length + 1 }))
    .sort((left, right) => left.size - right.size)
  for (const { entry, size } of bySize) {
    if (!entry.draft) {
      added.push(entry)
      continue
    }
    if (used + size > MAX_JOURNAL_CHARS) {
      continue
    }
    added.push(entry)
    used += size
  }
  if (added.length > 0) {
    writeEntries([...kept, ...added])
  }
}

/** Journals an addition the moment it is made; false when it doesn't fit or localStorage
 *  refused it, and the addition is then durable only once storage confirms it. */
export function journalNativeChatComposerDraftAddition(
  scopeKey: string,
  addition: NativeChatComposerDraftAddition,
  at: number
): boolean {
  const entries: JournalEntry[] = [...readEntries(), { scopeKey, at, run: THIS_RUN, addition }]
  const additions = JSON.stringify(entries.filter(isAddition)).length
  return additions <= MAX_JOURNAL_ADDITIONS_CHARS && writeEntries(entries)
}

/** Drops a draft's entries once a change to it at least as new is confirmed, by any window, so a
 *  replay never brings back what was sent or replaced since. */
export function pruneNativeChatComposerDraftJournal(scopeKey: string, confirmedAt: number): void {
  try {
    if (localStorage.getItem(JOURNAL_KEY) === null) {
      return
    }
  } catch {
    return
  }
  const entries = readEntries()
  const kept = entries.filter((entry) => entry.scopeKey !== scopeKey || entry.at > confirmedAt)
  if (kept.length !== entries.length) {
    writeEntries(kept)
  }
}
