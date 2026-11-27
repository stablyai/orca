import { nextSavedAt } from './native-chat-composer-draft-memory'
import {
  parseStoredNativeChatComposerDraft,
  type StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'
import { load, nativeChatDraftPositions, records } from './native-chat-composer-draft-memory'
import type { AppendBeforeLoad, DraftAppend } from './native-chat-composer-draft-load'

/**
 * Record an append made before saved drafts loaded, in run order, with whether the live draft had a
 * placement right after it (it was installed in memory just before this): the load tells a placement
 * a later step retired from a draft this run never placed.
 */
export function recordNativeChatAppendBeforeLoad(
  scopeKey: string,
  append: DraftAppend
): AppendBeforeLoad {
  load.appendSequence += 1
  const live = records.get(scopeKey)
  const entry: AppendBeforeLoad = {
    sequence: load.appendSequence,
    append,
    committed: false,
    placed: live ? nativeChatDraftPositions.has(live) : false
  }
  load.appendsBeforeLoad.set(scopeKey, [...(load.appendsBeforeLoad.get(scopeKey) ?? []), entry])
  return entry
}

export function applyNativeChatAppendToStorage(
  scopeKey: string,
  entry: AppendBeforeLoad,
  base: StoredNativeChatComposerDraft,
  append: DraftAppend,
  save: (draft: StoredNativeChatComposerDraft) => StoredNativeChatComposerDraft | null
): StoredNativeChatComposerDraft | null {
  const previous = load.appendsBeforeLoad
    .get(scopeKey)
    ?.findLast(
      (candidate) =>
        candidate.sequence < entry.sequence && candidate.committedSnapshot !== undefined
    )
  const input = { ...base }
  if (previous?.committedPosition && previous.committedSnapshot === JSON.stringify(base)) {
    nativeChatDraftPositions.set(input, { ...previous.committedPosition })
  }
  const appended = append(input)
  entry.committedPosition = nativeChatDraftPositions.get(appended)
  const saved = save({ ...appended, savedAt: nextSavedAt() })
  entry.committedSnapshot = JSON.stringify(saved && parseStoredNativeChatComposerDraft(saved))
  return saved
}
