// Journal unconfirmed drafts synchronously on unload; journal returned additions immediately because crashes skip unload and their source is deleted.

import type { UnconfirmedDraftChange } from './native-chat-composer-draft-memory'
import {
  withIndependentNativeChatComposerDraft,
  withNativeChatComposerDraftAddition,
  type NativeChatComposerDraftAddition
} from './native-chat-composer-draft-addition'
import {
  parseHandbackReceipt,
  parseStoredNativeChatComposerDraft,
  type NativeChatDraftHandbackReceipt,
  type StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'
import { hasHandbackReceipt, withHandbackReceipts } from './native-chat-composer-draft-custody'

const JOURNAL_KEY = 'orca:nativeChatComposerDraftJournal:v1'
// Cap whole drafts and additions separately to protect localStorage quota; always retain tiny removal entries to prevent sent drafts returning.
export const MAX_JOURNAL_CHARS = 256_000
export const MAX_JOURNAL_ADDITIONS_CHARS = 800_000

// Replay only earlier runs’ entries; this run already holds its own changes in memory.
const THIS_RUN = `${Date.now()}-${Math.random()}`

type EntryBase = { readonly scopeKey: string; readonly at: number; readonly run?: string }
type DraftEntry = EntryBase & { readonly draft: StoredNativeChatComposerDraft | null }
/** An identified hand-back: applied once as an independent contribution, with its receipt. */
export type NativeChatDraftJournalCustody = {
  readonly handback: NativeChatDraftHandbackReceipt
  readonly sourcePaths?: readonly string[]
}
type AdditionEntry = EntryBase & {
  readonly addition: NativeChatComposerDraftAddition
  readonly custody?: NativeChatDraftJournalCustody
}
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

/** Snapshot before reading storage so later live-window writes cannot be overwritten by replay. */
export function snapshotNativeChatComposerDraftJournal(): NativeChatComposerDraftJournalSnapshot {
  return readEntries().filter((entry) => entry.run !== THIS_RUN)
}

/** Replay newer drafts and additions once, return changed drafts for persistence, and discard entries older than storage. */
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
  for (const { scopeKey, at, addition, custody } of additions) {
    const base = drafts.get(scopeKey) ?? null
    if ((base?.savedAt ?? removedAt.get(scopeKey) ?? 0) >= at) {
      pruneNativeChatComposerDraftJournal(scopeKey, at)
      continue
    }
    // Its receipt, not its text, says whether the draft already holds an identified hand-back.
    if (custody && hasHandbackReceipt(base?.handbacks, custody.handback)) {
      continue
    }
    const from = base ?? { text: '', images: [], savedAt: 0 }
    drafts.set(
      scopeKey,
      custody
        ? {
            ...from,
            ...withIndependentNativeChatComposerDraft(from, addition),
            handbacks: withHandbackReceipts(from.handbacks, [custody.handback]),
            sourcePaths: [
              ...new Set([...(from.sourcePaths ?? []), ...(custody.sourcePaths ?? [])])
            ],
            savedAt: at
          }
        : { ...from, ...withNativeChatComposerDraftAddition(from, addition), savedAt: at }
    )
    changed.add(scopeKey)
  }
  return changed
}

/** Preserve other windows’ entries and journal unconfirmed changes within the whole-draft cap; omitted writes still go to storage. Returns the scopes actually written. */
export function journalNativeChatComposerDraftChanges(
  changes: ReadonlyMap<string, UnconfirmedDraftChange>
): Set<string> {
  const written = new Set<string>()
  if (changes.size === 0) {
    return written
  }
  const entries = readEntries()
  let used = JSON.stringify(
    entries.filter(
      (entry) =>
        !isAddition(entry) &&
        entry.draft &&
        (!changes.has(entry.scopeKey) || entry.draft.handbacks?.length)
    )
  ).length
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
  const replaced = new Set(added.map((entry) => entry.scopeKey))
  // A capped-out change leaves its scope's last receipt-bearing copy: it may be the only proof.
  const kept = entries.filter(
    (entry) =>
      isAddition(entry) ||
      !changes.has(entry.scopeKey) ||
      (!replaced.has(entry.scopeKey) && Boolean(entry.draft?.handbacks?.length))
  )
  if (added.length > 0 && writeEntries([...kept, ...added])) {
    replaced.forEach((scopeKey) => written.add(scopeKey))
  }
  return written
}

/** Journal additions immediately; false means they need storage confirmation before their source can be deleted. */
export function journalNativeChatComposerDraftAddition(
  scopeKey: string,
  addition: NativeChatComposerDraftAddition,
  at: number,
  custody?: NativeChatDraftJournalCustody
): boolean {
  const entries: JournalEntry[] = [
    ...readEntries(),
    { scopeKey, at, run: THIS_RUN, addition, ...(custody ? { custody } : {}) }
  ]
  const additions = JSON.stringify(entries.filter(isAddition)).length
  return additions <= MAX_JOURNAL_ADDITIONS_CHARS && writeEntries(entries)
}

/** Any window’s newer confirmed write prunes older entries so replay cannot resurrect sent or replaced drafts. */
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
