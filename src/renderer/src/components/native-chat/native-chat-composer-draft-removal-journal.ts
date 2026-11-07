import { JOURNAL_KEY } from './native-chat-composer-draft-journal'
import { parseStoredNativeChatComposerDraft } from './native-chat-composer-draft-storage'

export function captureNativeChatRemovalJournal(): readonly unknown[] | null {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY)
    const value: unknown = raw === null ? [] : JSON.parse(raw)
    return Array.isArray(value) ? value : null
  } catch {
    return typeof localStorage === 'undefined' ? [] : null
  }
}

export function nativeChatRemovalJournalScope(entry: unknown): string | null {
  if (
    !entry ||
    typeof entry !== 'object' ||
    !('scopeKey' in entry) ||
    typeof entry.scopeKey !== 'string' ||
    !('at' in entry) ||
    typeof entry.at !== 'number'
  ) {
    return null
  }
  if (
    'draft' in entry &&
    (entry.draft === null || parseStoredNativeChatComposerDraft(entry.draft))
  ) {
    return entry.scopeKey
  }
  if (
    'addition' in entry &&
    entry.addition &&
    typeof entry.addition === 'object' &&
    'images' in entry.addition &&
    Array.isArray(entry.addition.images)
  ) {
    return entry.scopeKey
  }
  return null
}

/** Filter fresh bytes once; timestamps and parsing never authorize dropping a replacement. */
export function settleNativeChatRemovalJournal(
  captured: readonly unknown[] | null,
  scopes: ReadonlySet<string>
): { ok: boolean; removed: ReadonlySet<string> } {
  const selected = new Map<string, number>()
  for (const entry of captured ?? []) {
    const scope = nativeChatRemovalJournalScope(entry)
    if (scope && scopes.has(scope)) {
      const key = JSON.stringify(entry)
      selected.set(key, (selected.get(key) ?? 0) + 1)
    }
  }
  const removed = new Set(selected.keys())
  const fresh = captureNativeChatRemovalJournal()
  if (captured === null || fresh === null) {
    return { ok: false, removed: new Set() }
  }
  const kept = fresh.filter((entry) => {
    const key = JSON.stringify(entry)
    const count = selected.get(key) ?? 0
    if (count === 0) {
      return true
    }
    selected.set(key, count - 1)
    return false
  })
  if (kept.length !== fresh.length) {
    try {
      if (kept.length) {
        localStorage.setItem(JOURNAL_KEY, JSON.stringify(kept))
      } else {
        localStorage.removeItem(JOURNAL_KEY)
      }
    } catch {
      return { ok: false, removed: new Set() }
    }
  }
  return { ok: true, removed }
}
