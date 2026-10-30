import type { Editor } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'

export const richMarkdownClipboardInsertionOrderKey = new PluginKey<number>(
  'richMarkdownClipboardInsertionOrder'
)
const requestOrders = new WeakMap<Editor, number>()

export function captureRichMarkdownClipboardInsertionOrder(editor: Editor): number {
  const requestOrder = (requestOrders.get(editor) ?? 0) + 1
  requestOrders.set(editor, requestOrder)
  return requestOrder
}
