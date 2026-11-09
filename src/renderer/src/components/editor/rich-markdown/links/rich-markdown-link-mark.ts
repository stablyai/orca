import { mergeAttributes, type PasteRuleFinder, type PasteRuleMatch } from '@tiptap/core'
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
    const matches: PasteRuleMatch[] = []
    let offset = 0
    splitAtProseUrlTerminators(text).forEach((piece, index) => {
      if (index % 2 === 0) {
        for (const match of find(piece, event) ?? []) {
          matches.push({ ...match, index: match.index + offset })
        }
      }
      offset += piece.length
    })
    return matches
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
    const rules = this.parent?.() ?? []
    for (const rule of rules) {
      rule.find = findBetweenProseTerminators(rule.find)
    }
    return rules
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
