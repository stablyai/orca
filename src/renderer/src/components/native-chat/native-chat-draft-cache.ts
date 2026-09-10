import type { JSONContent } from '@tiptap/react'
// Module-level cache for the composer's in-progress draft text, keyed by the
// same stable pane scope as image attachments. The composer unmounts when the
// pane toggles back to the hosted terminal, so without this the typed-but-unsent
// draft would be lost on every TUI/GUI round-trip. Mirrors the attachment cache
// so both halves of an unsent message survive toggles and reconnects.

import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'

const draftCache = new Map<string, { text: string; document?: JSONContent }>()

export function readNativeChatDraftCache(scopeKey: string): string {
  return draftCache.get(scopeKey)?.text ?? ''
}

export function writeNativeChatDraftCache(scopeKey: string, draft: string): void {
  // An empty draft carries no state worth retaining; drop the entry so a stale
  // scope key never resurrects cleared text.
  if (draft === '') {
    draftCache.delete(scopeKey)
    return
  }
  // LRU-bounded so unsent drafts for permanently-removed panes can't accumulate.
  setBoundedScopeCacheEntry(draftCache, scopeKey, {
    text: draft,
    document:
      draftCache.get(scopeKey)?.text === draft ? draftCache.get(scopeKey)?.document : undefined
  })
}

export function clearNativeChatDraftCacheForTests(): void {
  draftCache.clear()
}

export function readNativeChatDraftDocument(
  scopeKey: string,
  text: string
): JSONContent | undefined {
  const cached = draftCache.get(scopeKey)
  return cached?.text === text ? cached.document : undefined
}

export function writeNativeChatDraftDocument(
  scopeKey: string,
  text: string,
  document: JSONContent
): void {
  if (!text) {
    draftCache.delete(scopeKey)
    return
  }
  setBoundedScopeCacheEntry(draftCache, scopeKey, { text, document })
}
