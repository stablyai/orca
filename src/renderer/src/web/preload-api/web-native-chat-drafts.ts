import type { NativeChatDraftsApi } from '../../../../preload/api-types'
import {
  isEmptyNativeChatDraft,
  parseNativeChatDraft,
  type PersistedNativeChatDraft,
  type SavedNativeChatDraft
} from '../../../../shared/native-chat-draft-record'

// The web client keeps drafts in this browser's storage, never on the runtime it is paired with.
// The browser commits storage to disk on its own schedule, so a browser crash right after Enter
// can still bring a sent draft back; an Orca reload or tab crash cannot.
const DRAFT_PREFIX = 'orca:nativeChatComposerDraft:v1:'
const MAX_SAVED_DRAFTS = 128

function storageKey(scopeKey: string): string {
  return `${DRAFT_PREFIX}${encodeURIComponent(scopeKey)}`
}

function draftStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function parseStoredDraft(
  raw: string | null
): { draft: PersistedNativeChatDraft; savedAt: number } | null {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null
    const draft = parseNativeChatDraft(value)
    const savedAt =
      typeof value === 'object' && value !== null && 'savedAt' in value ? value.savedAt : 0
    return draft ? { draft, savedAt: typeof savedAt === 'number' ? savedAt : 0 } : null
  } catch {
    return null
  }
}

/** Reads every saved draft, oldest first; unreadable ones and those past the cap are deleted. */
function loadDrafts(): SavedNativeChatDraft[] {
  const storage = draftStorage()
  if (!storage) {
    return []
  }
  try {
    const loaded: (SavedNativeChatDraft & { savedAt: number })[] = []
    const discarded: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (!key?.startsWith(DRAFT_PREFIX)) {
        continue
      }
      const saved = parseStoredDraft(storage.getItem(key))
      if (saved) {
        loaded.push({ scopeKey: decodeURIComponent(key.slice(DRAFT_PREFIX.length)), ...saved })
      } else {
        discarded.push(key)
      }
    }
    loaded.sort((left, right) => left.savedAt - right.savedAt)
    const kept = loaded.slice(Math.max(0, loaded.length - MAX_SAVED_DRAFTS))
    for (const { scopeKey } of loaded.slice(0, loaded.length - kept.length)) {
      discarded.push(storageKey(scopeKey))
    }
    discarded.forEach((key) => storage.removeItem(key))
    return kept.map(({ scopeKey, draft }) => ({ scopeKey, draft }))
  } catch {
    return []
  }
}

export function createWebNativeChatDrafts(): NativeChatDraftsApi {
  return {
    savesSendClearAtOnce: true,
    load: async () => loadDrafts(),
    loadSync: loadDrafts,
    write: async (scopeKey, draft) => {
      const storage = draftStorage()
      if (!storage) {
        return 'unavailable'
      }
      try {
        if (!draft || isEmptyNativeChatDraft(draft)) {
          storage.removeItem(storageKey(scopeKey))
        } else {
          storage.setItem(storageKey(scopeKey), JSON.stringify({ ...draft, savedAt: Date.now() }))
        }
        return 'persisted'
      } catch {
        return 'failed'
      }
    },
    onExternalChange: (listener) => {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
        return
      }
      // Another tab of this origin wrote; a tab never hears its own writes.
      window.addEventListener('storage', (event) => {
        if (event.key?.startsWith(DRAFT_PREFIX)) {
          listener(
            decodeURIComponent(event.key.slice(DRAFT_PREFIX.length)),
            parseStoredDraft(event.newValue)?.draft ?? null
          )
        }
      })
    }
  }
}
