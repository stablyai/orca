import type { Node } from '@tiptap/pm/model'
import { readNativeChatComposerDraft } from './native-chat-composer-draft-store'
import { nativeChatPastedTextId } from './native-chat-pasted-text-reference'

/** A grouped Undo can cross a reconstructed atom; its intermediate documents retain the path. */
export function createNativeChatPastedTextHistory(scope: string) {
  const paths = new WeakMap<Node['attrs'], string>()
  return (doc: Node, before: readonly Node[] = []): Record<string, string> => {
    const saved = readNativeChatComposerDraft(scope).pastedTextFiles
    const carried: Record<string, string> = {}
    for (const previous of before) {
      previous.descendants((node) => {
        const id = nativeChatPastedTextId(String(node.attrs.token ?? ''))
        const path = paths.get(node.attrs)
        if (id && path) {
          carried[id] = path
        }
      })
    }
    const current: Record<string, string> = {}
    doc.descendants((node) => {
      const id = nativeChatPastedTextId(String(node.attrs.token ?? ''))
      const path = id ? (saved?.[id] ?? paths.get(node.attrs) ?? carried[id]) : undefined
      if (id && path) {
        paths.set(node.attrs, path)
        current[id] = path
      }
    })
    return current
  }
}
