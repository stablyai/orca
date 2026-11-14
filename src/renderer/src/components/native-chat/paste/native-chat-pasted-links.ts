import { clipboardHtmlMayHaveLinks } from '../../../../../shared/clipboard-link-html'

const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
// A page dump with more links than this pastes as plain text rather than paying a long scan.
const MAX_PASTED_LINKS = 256

function linkUrl(href: string): URL | null {
  try {
    const url = new URL(href)
    return LINK_PROTOCOLS.has(url.protocol) ? url : null
  } catch {
    return null
  }
}

function markdownLink(label: string, href: string): string {
  const escapedLabel = label.replace(/[\\[\]]/g, '\\$&')
  const destination = href.replace(
    /[\s()]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  )
  return `[${escapedLabel}](${destination})`
}

const WORD_CHAR = /[\p{L}\p{N}_]/u
// Total characters label searches may pass over in one paste; short labels that only occur inside words would otherwise rescan the text per anchor.
const MAX_SEARCHED_CHARS = 2 * 1024 * 1024

/** The label's next whole-word occurrence, so a short label cannot land inside a longer word. */
function findLabel(text: string, label: string, from: number, budget: { left: number }): number {
  const startsWord = WORD_CHAR.test(label[0])
  const endsWord = WORD_CHAR.test(label.at(-1) ?? '')
  for (let start = from; budget.left > 0;) {
    const at = text.indexOf(label, start)
    budget.left -= (at === -1 ? text.length : at + 1) - start
    if (at === -1) {
      return -1
    }
    const end = at + label.length
    if (
      !(startsWord && at > 0 && WORD_CHAR.test(text[at - 1])) &&
      !(endsWord && end < text.length && WORD_CHAR.test(text[end]))
    ) {
      return at
    }
    start = at + 1
  }
  return -1
}

/** Rich-text copies keep their links as Markdown; the plain text otherwise stays as the source wrote it. */
export function withPastedLinks(text: string, html: string | null | undefined): string {
  if (!text || !html || !clipboardHtmlMayHaveLinks(html)) {
    return text
  }
  const anchors = new DOMParser().parseFromString(html, 'text/html').querySelectorAll('a[href]')
  if (anchors.length > MAX_PASTED_LINKS) {
    return text
  }
  let result = ''
  let cursor = 0
  const budget = { left: MAX_SEARCHED_CHARS }
  for (const anchor of anchors) {
    if (budget.left <= 0) {
      break
    }
    const label = (anchor.textContent ?? '').replace(/\s+/g, ' ').trim()
    const at = label ? findLabel(text, label, cursor, budget) : -1
    if (at === -1) {
      continue
    }
    const end = at + label.length
    const href = anchor.getAttribute('href')?.trim() ?? ''
    const url = linkUrl(href)
    // Unlinked anchors still advance the cursor, so a later label cannot match inside them.
    const linked =
      url &&
      label !== href &&
      label !== url.href &&
      `mailto:${label}` !== href &&
      // The plain flavor may already carry Markdown links.
      !(text[at - 1] === '[' && text.startsWith('](', end))
    result += text.slice(cursor, at) + (linked ? markdownLink(label, href) : label)
    cursor = end
  }
  return result + text.slice(cursor)
}

/** Pasting one URL over selected words links them, as most message editors do. */
export function linkedSelectionText(selected: string, pasted: string): string | null {
  const href = pasted.trim()
  if (
    !selected.trim() ||
    /[\r\n]/.test(selected) ||
    /\s/.test(href) ||
    !linkUrl(href) ||
    linkUrl(selected.trim())
  ) {
    return null
  }
  return markdownLink(selected, href)
}
