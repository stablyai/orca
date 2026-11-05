import { mergeAttributes, type PasteRuleFinder } from '@tiptap/core'
import Link from '@tiptap/extension-link'
import {
  findProseUrlEnd,
  splitAtProseUrlTerminators
} from '../../../../../../shared/prose-url-boundary'

function isFileUri(href: unknown): href is string {
  return typeof href === 'string' && /^file:/i.test(href.trim())
}

// Linkify reads CJK punctuation as part of a url, so pasted text is matched one prose piece at a time.
function findBetweenProseTerminators(find: PasteRuleFinder): PasteRuleFinder {
  if (typeof find !== 'function') {
    return find
  }
  return (text, event) => {
    let offset = 0
    return splitAtProseUrlTerminators(text).flatMap((piece, index) => {
      const pieceOffset = offset
      offset += piece.length
      return index % 2 === 0 && piece
        ? (find(piece, event) ?? []).map((match) => ({
            ...match,
            index: match.index + pieceOffset
          }))
        : []
    })
  }
}

export const RichMarkdownLink = Link.extend({
  addOptions() {
    const parent = this.parent!()
    return {
      ...parent,
      // Typed autolinks cannot be shortened, so a url run into CJK prose stays plain text.
      shouldAutoLink: (url) => findProseUrlEnd(url) === -1 && parent.shouldAutoLink(url)
    }
  },
  addPasteRules() {
    return (this.parent?.() ?? []).map((rule) => {
      rule.find = findBetweenProseTerminators(rule.find)
      return rule
    })
  },
  // Why: Tiptap blanks file: hrefs in clipboard HTML, so copy/paste dropped those links. Admitting
  // them only in HTML transfer keeps autolink and plain-URL paste rules ignoring bare file: text.
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
