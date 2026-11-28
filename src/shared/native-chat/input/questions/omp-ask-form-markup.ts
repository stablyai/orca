import { decodeHtmlEntities } from '../../../text/html-entities'
import { htmlStartTagEnd } from '../../../text/html-start-tag-end'

// OMP's ask form HTML as an element tree, read without a DOM because the phone has none.

export type FormMarkupNode = FormMarkupElement | string

export type FormMarkupElement = {
  tag: string
  attrs: Readonly<Record<string, string>>
  children: FormMarkupNode[]
  parent: FormMarkupElement | null
}

/** Open elements a start tag closes (`ends`), searched up to the nearest of its containers (`within`). */
type ImpliedEnd = { ends: ReadonlySet<string>; within: ReadonlySet<string> }

export const formTagSet = (tags: string): ReadonlySet<string> => new Set(tags.split(' '))

const VOID_TAGS = formTagSet('area base br col embed hr img input link meta param source track wbr')
const RAW_TEXT_TAGS = formTagSet('script style textarea title')
const CLOSES_PARAGRAPH = formTagSet(
  'address article aside blockquote dd details div dl dt fieldset figcaption figure footer form ' +
    'h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table ul'
)
const TABLE_SECTION_END: ImpliedEnd = {
  ends: formTagSet('thead tbody tfoot tr td th'),
  within: formTagSet('table')
}
const CELL_END: ImpliedEnd = { ends: formTagSet('td th'), within: formTagSet('tr table') }
const TERM_END: ImpliedEnd = { ends: formTagSet('dt dd'), within: formTagSet('dl table td th') }
const IMPLIED_END = new Map<string, ImpliedEnd>([
  ['li', { ends: formTagSet('li'), within: formTagSet('ul ol menu table td th') }],
  ['dt', TERM_END],
  ['dd', TERM_END],
  ['option', { ends: formTagSet('option'), within: formTagSet('select datalist optgroup') }],
  ['optgroup', { ends: formTagSet('option optgroup'), within: formTagSet('select datalist') }],
  // Unlike OMP and as in HTML, a `<select>` ends an open one, so nested selects never rescan each other.
  ['select', { ends: formTagSet('select'), within: formTagSet('form') }],
  ['tr', { ends: formTagSet('tr td th'), within: formTagSet('table thead tbody tfoot') }],
  ['td', CELL_END],
  ['th', CELL_END],
  ['thead', TABLE_SECTION_END],
  ['tbody', TABLE_SECTION_END],
  ['tfoot', TABLE_SECTION_END]
])
// Deeper start tags open nothing, so hostile nesting cannot overflow the stack or go quadratic.
const MAX_FORM_DEPTH = 32

function readAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null)
  if (!source.trim()) {
    return attrs
  }
  const pattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
  for (const match of source.matchAll(pattern)) {
    const name = match[1]!.toLowerCase()
    if (!(name in attrs)) {
      attrs[name] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '')
    }
  }
  return attrs
}

// A data URI's payload, or an inline SVG's start tag; ':' stays out of the media type so runs never rescan.
const INLINE_MEDIA = /\bdata:[^,:"'\s>]*,[^"'\s>)]*|<svg(?=[\s/>])/gi
const SVG_END = /<\/svg\s*>/gi

/** The first `limit` chars of `html`, emptying image data and SVG drawings (no question text) when it is longer. */
export function formHtmlWithoutMedia(html: string, limit: number): string {
  if (html.length <= limit) {
    return html
  }
  const parts: string[] = []
  let length = 0
  let from = 0
  INLINE_MEDIA.lastIndex = 0
  for (
    let match = INLINE_MEDIA.exec(html);
    match && length + match.index - from < limit;
    match = INLINE_MEDIA.exec(html)
  ) {
    let end = INLINE_MEDIA.lastIndex
    let kept = 'data:,'
    if (match[0][0] === '<') {
      const tagEnd = htmlStartTagEnd(html, end)
      if (tagEnd === -1) {
        break
      }
      if (html[tagEnd - 1] === '/') {
        INLINE_MEDIA.lastIndex = tagEnd + 1
        continue
      }
      SVG_END.lastIndex = tagEnd
      if (!SVG_END.test(html)) {
        break
      }
      end = SVG_END.lastIndex
      INLINE_MEDIA.lastIndex = end
      kept = '<svg></svg>'
    }
    parts.push(html.slice(from, match.index), kept)
    length += match.index - from + kept.length
    from = end
  }
  parts.push(html.slice(from, from + Math.max(limit - length, 0)))
  return parts.join('').slice(0, limit)
}

/** Closes every open element `rule` ends, up to the nearest of its containers. */
function closeImplied(open: FormMarkupElement[], rule: ImpliedEnd): void {
  for (let depth = open.length - 1; depth >= 0 && !rule.within.has(open[depth]!.tag); depth -= 1) {
    if (rule.ends.has(open[depth]!.tag)) {
      open.length = depth
    }
  }
}

/** Reads agent-written HTML leniently, closing what HTML closes implicitly (`<p>`, `<li>`, `<option>`, table cells). */
export function readFormMarkup(html: string): FormMarkupElement {
  const root: FormMarkupElement = { tag: '#root', attrs: {}, children: [], parent: null }
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/y
  const open: FormMarkupElement[] = []
  let index = 0
  while (index < html.length) {
    const current = open.at(-1) ?? root
    const lt = html.indexOf('<', index)
    const textEnd = lt === -1 ? html.length : lt
    if (textEnd > index) {
      current.children.push(decodeHtmlEntities(html.slice(index, textEnd)))
    }
    if (lt === -1) {
      break
    }
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4)
      index = close === -1 ? html.length : close + 3
      continue
    }
    tagPattern.lastIndex = lt
    const tag = tagPattern.exec(html)
    if (!tag) {
      // `<!doctype>` and `<?…>` run to their `>` (or the end) and drop; any other `<` is text.
      if (html[lt + 1] === '!' || html[lt + 1] === '?') {
        const close = html.indexOf('>', lt)
        index = close === -1 ? html.length : close + 1
      } else {
        current.children.push('<')
        index = lt + 1
      }
      continue
    }
    const name = tag[2]!.toLowerCase()
    const attributesStart = tagPattern.lastIndex
    const end = htmlStartTagEnd(html, attributesStart)
    if (end === -1) {
      current.children.push(decodeHtmlEntities(html.slice(lt)))
      break
    }
    index = end + 1
    if (tag[1]) {
      // An end tag closes its nearest open element; a stray one is ignored.
      const match = open.findLastIndex((element) => element.tag === name)
      if (match !== -1) {
        open.length = match
      }
      continue
    }
    // Like OMP, a block closes only a `<p>` that is the open element.
    if (CLOSES_PARAGRAPH.has(name) && open.at(-1)?.tag === 'p') {
      open.pop()
    }
    const implied = IMPLIED_END.get(name)
    if (implied) {
      closeImplied(open, implied)
    }
    const parent = open.at(-1) ?? root
    const attributes = html.slice(attributesStart, end)
    const element: FormMarkupElement = {
      tag: name,
      attrs: readAttributes(attributes),
      children: [],
      parent
    }
    parent.children.push(element)
    if (RAW_TEXT_TAGS.has(name)) {
      const closer = new RegExp(`</${name}[\\s/>]`, 'gi')
      closer.lastIndex = index
      const close = closer.exec(html)?.index ?? html.length
      const raw = html.slice(index, close)
      if (raw) {
        const escapable = name === 'textarea' || name === 'title'
        element.children.push(escapable ? decodeHtmlEntities(raw) : raw)
      }
      const closeEnd = html.indexOf('>', close)
      index = closeEnd === -1 ? html.length : closeEnd + 1
      continue
    }
    if (
      !VOID_TAGS.has(name) &&
      !attributes.trimEnd().endsWith('/') &&
      open.length < MAX_FORM_DEPTH
    ) {
      open.push(element)
    }
  }
  return root
}

export function formElementChildren(element: FormMarkupElement): FormMarkupElement[] {
  return element.children.filter((child): child is FormMarkupElement => typeof child !== 'string')
}

/** Descendant elements in document order. */
export function formDescendants(
  element: FormMarkupElement,
  matches: (candidate: FormMarkupElement) => boolean
): FormMarkupElement[] {
  const found: FormMarkupElement[] = []
  const visit = (node: FormMarkupElement): void => {
    for (const child of formElementChildren(node)) {
      if (matches(child)) {
        found.push(child)
      }
      visit(child)
    }
  }
  visit(element)
  return found
}

export function formClosest(element: FormMarkupElement, tag: string): FormMarkupElement | null {
  for (let node: FormMarkupElement | null = element; node; node = node.parent) {
    if (node.tag === tag) {
      return node
    }
  }
  return null
}

export function formTextContent(node: FormMarkupNode): string {
  return typeof node === 'string' ? node : node.children.map(formTextContent).join('')
}

/** Collapse whitespace as HTML layout does, onto one line. */
export function formPlainText(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim()
}
