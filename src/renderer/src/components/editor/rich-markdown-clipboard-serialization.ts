import { DOMSerializer, type Slice } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'

export function serializeRichMarkdownSliceForClipboard(
  view: EditorView,
  slice: Slice
): { html: string } {
  if (typeof view.serializeForClipboard === 'function') {
    return { html: view.serializeForClipboard(slice).dom.innerHTML }
  }
  // Legacy unit-test views lack the public serializer; production uses the metadata-preserving branch.
  const fragment = DOMSerializer.fromSchema(view.state.schema).serializeFragment(slice.content)
  const container = document.createElement('div')
  container.appendChild(fragment)
  return { html: container.innerHTML }
}
