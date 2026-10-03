import type { JSONContent } from '@tiptap/react'
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'

// Rich editor state belongs to the pane's editor, not the chat; memory only.
const documentCache = new Map<string, { text: string; document: JSONContent }>()

export function readNativeChatDraftDocument(
  paneKey: string,
  text: string
): JSONContent | undefined {
  const cached = documentCache.get(paneKey)
  return cached?.text === text ? cached.document : undefined
}

export function writeNativeChatDraftDocument(
  paneKey: string,
  text: string,
  document: JSONContent
): void {
  if (!text) {
    documentCache.delete(paneKey)
    return
  }
  setBoundedScopeCacheEntry(documentCache, paneKey, { text, document })
}

export function clearNativeChatDraftDocumentsForTests(): void {
  documentCache.clear()
}
