import { mergeAttributes } from '@tiptap/core'
import Link from '@tiptap/extension-link'

function isFileUri(href: unknown): href is string {
  return typeof href === 'string' && /^file:/i.test(href.trim())
}

// Why: Tiptap blanks file: hrefs in clipboard HTML, so copy/paste dropped those links. Admitting
// them only in HTML transfer keeps autolink and plain-URL paste rules ignoring bare file: text.
export const RichMarkdownLink = Link.extend({
  parseHTML() {
    return [
      {
        tag: 'a[href]',
        getAttrs: (dom) => (isFileUri(dom.getAttribute('href')) ? null : false)
      },
      ...(this.parent?.() ?? [])
    ]
  },
  renderHTML({ HTMLAttributes, mark }) {
    if (isFileUri(HTMLAttributes.href)) {
      return ['a', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0]
    }
    return this.parent?.({ HTMLAttributes, mark }) ?? ['a', HTMLAttributes, 0]
  }
})
