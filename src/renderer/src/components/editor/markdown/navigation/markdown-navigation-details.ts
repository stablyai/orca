import type { TiptapEditorHTMLElement } from '@tiptap/core'

export function revealMarkdownNavigationDetails(target: HTMLElement): void {
  for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor instanceof HTMLDetailsElement) {
      const summary = ancestor.querySelector(':scope > summary')
      if (!summary?.contains(target)) {
        ancestor.open = true
      }
    }
  }

  const element = target.closest<TiptapEditorHTMLElement>('.tiptap')
  const editor = element?.editor
  if (!editor || editor.isDestroyed || editor.view.dom !== element) {
    return
  }
  const position = editor.state.doc.resolve(editor.view.posAtDOM(target, 0))
  const transaction = editor.state.tr
  for (let depth = 1; depth <= position.depth; depth += 1) {
    const node = position.node(depth)
    if (node.type.name !== 'details' || position.index(depth) === 0) {
      continue
    }
    if (!editor.isEditable) {
      const nodeElement = editor.view.nodeDOM(position.before(depth))
      if (
        nodeElement instanceof HTMLElement &&
        nodeElement.querySelector(':scope > div > [data-type="detailsContent"][hidden]')
      ) {
        nodeElement.querySelector<HTMLButtonElement>(':scope > button')?.click()
      }
    } else if (!node.attrs.open) {
      transaction.setNodeMarkup(position.before(depth), undefined, { ...node.attrs, open: true })
    }
  }
  if (transaction.docChanged) {
    editor.view.dispatch(transaction)
  }
}
