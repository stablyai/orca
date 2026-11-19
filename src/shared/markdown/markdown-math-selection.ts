/** A selection's text with each `[data-math-source]` formula as its TeX, not KaTeX's duplicated
 *  visual and MathML text; null when the selection holds no formula. Desktop and mobile chat copy it. */
export function markdownMathSelectionText(selection: Selection, root: Element): string | null {
  if (selection.isCollapsed || !selection.rangeCount) {
    return null
  }
  const range = selection.getRangeAt(0).cloneRange()
  const ancestor = range.commonAncestorContainer
  const container = ancestor instanceof Element ? ancestor : ancestor.parentElement
  if (!container || !root.contains(container)) {
    return null
  }
  const containingFormula = container.closest<HTMLElement>('[data-math-source]')
  if (containingFormula && root.contains(containingFormula)) {
    return containingFormula.dataset.mathSource ?? ''
  }
  const formulas = Array.from(container.querySelectorAll<HTMLElement>('[data-math-source]')).filter(
    (element) => range.intersectsNode(element)
  )
  if (!formulas.length) {
    return null
  }
  const first = formulas[0]
  const last = formulas.at(-1)
  if (first.contains(range.startContainer)) {
    range.setStartBefore(first)
  }
  if (last?.contains(range.endContainer)) {
    range.setEndAfter(last)
  }
  const out: SelectionText = {
    parts: [],
    lastChar: '',
    lineBreaks: 0,
    space: false,
    keepsWhiteSpace: new Map()
  }
  appendSelectedChildren(container, range, out)
  const text = out.parts.join('')
  const trimmed = text.trimEnd()
  // Native copy keeps a last row's empty-cell tabs, but not a fully empty last row.
  const tail = text.slice(trimmed.length)
  const kept = trimmed + tail.slice(0, tail.lastIndexOf('\t') + 1)
  return /(^|\n)\t+$/.test(kept) ? trimmed : kept
}

/** Puts the selection on the clipboard as {@link markdownMathSelectionText} when it holds a formula. */
export function copyMarkdownMathSelection(
  event: { defaultPrevented: boolean; clipboardData: DataTransfer | null; preventDefault(): void },
  root: Element
): void {
  const selection = root.ownerDocument.getSelection()
  const text = selection && markdownMathSelectionText(selection, root)
  if (event.defaultPrevented || text === null || text === undefined || !event.clipboardData) {
    return
  }
  event.clipboardData.setData('text/plain', text)
  event.clipboardData.setData('text/html', '')
  event.preventDefault()
}

// Chromium's copy starts and ends these on their own line, and adds a blank line after a paragraph.
const LINE_BLOCK_TAGS = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'DIV',
  'BLOCKQUOTE',
  'PRE',
  'HR',
  'SECTION',
  'DETAILS',
  'SUMMARY',
  'DL',
  'DT',
  'DD',
  'UL',
  'OL',
  'LI',
  'TABLE',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR'
])

const HIDDEN_SELECTOR =
  '.select-none, .sr-only, [aria-hidden="true"], button, input, script, style, svg'

/** Separators are held as pending state so adjacent block edges share one break, like native copy. */
type SelectionText = {
  parts: string[]
  lastChar: string
  lineBreaks: number
  space: boolean
  keepsWhiteSpace: Map<Element, boolean>
}

/** Only the boundary children need range checks; the siblings between them are fully selected. */
function appendSelectedChildren(parent: Node, range: Range, out: SelectionText): void {
  const start = boundaryChild(parent, range.startContainer, range.startOffset)
  const end = boundaryChild(parent, range.endContainer, range.endOffset)
  const stop = end && !end.partial ? end.child : null
  for (let child = start ? start.child : parent.firstChild; child && child !== stop;) {
    const isStart = start?.partial === true && child === start.child
    const isEnd = end?.partial === true && child === end.child
    appendSelectionText(child, range, out, !isStart && !isEnd)
    child = isEnd ? null : child.nextSibling
  }
}

/** Locates a boundary point once per parent so the walk avoids an intersectsNode call per child. */
function boundaryChild(
  parent: Node,
  container: Node,
  offset: number
): { child: Node | null; partial: boolean } | undefined {
  if (container === parent) {
    return { child: parent.childNodes[offset] ?? null, partial: false }
  }
  let child: Node | null = container
  while (child && child.parentNode !== parent) {
    child = child.parentNode
  }
  return child ? { child, partial: true } : undefined
}

// `contained`: the range covers all of node, so its subtree is walked without range checks.
function appendSelectionText(
  node: Node,
  range: Range,
  out: SelectionText,
  contained: boolean
): void {
  if (node instanceof Text) {
    const end = node === range.endContainer ? range.endOffset : undefined
    const data = node.data.slice(node === range.startContainer ? range.startOffset : 0, end)
    // Text without whitespace reads the same either way, so it skips the style lookup.
    if (
      !/[\t\n\f\r ]/.test(data) ||
      (node.parentElement && keepsWhiteSpace(node.parentElement, out.keepsWhiteSpace))
    ) {
      appendText(out, data)
      return
    }
    // Like CSS, runs of collapsible whitespace show as one space, and not at a line's edges.
    const collapsed = data.replace(/[\t\n\f\r ]+/g, ' ')
    out.space ||= collapsed.startsWith(' ')
    appendText(out, collapsed.replace(/^ | $/g, ''))
    out.space ||= collapsed.endsWith(' ')
    return
  }
  if (!(node instanceof Element)) {
    return
  }
  const formula = node.getAttribute('data-math-source')
  if (formula !== null) {
    // Display equations are block spans, so they start and end their own line.
    const lineBreaks = getComputedStyle(node).display === 'block' ? 1 : 0
    out.lineBreaks = Math.max(out.lineBreaks, lineBreaks)
    appendText(out, formula)
    out.lineBreaks = Math.max(out.lineBreaks, lineBreaks)
    return
  }
  if (node.matches(HIDDEN_SELECTOR)) {
    return
  }
  if (node.tagName === 'BR') {
    out.space = false
    appendText(out, out.lastChar && '\n')
    return
  }
  // A cell after its row's first is tab-separated unless a br ended its line.
  if (
    /^T[DH]$/.test(node.tagName) &&
    node.previousElementSibling &&
    out.lastChar !== '' &&
    out.lastChar !== '\n'
  ) {
    out.space = false
    appendText(out, '\t')
  }
  const lineBreaks = LINE_BLOCK_TAGS.has(node.tagName) ? 1 : 0
  out.lineBreaks = Math.max(out.lineBreaks, lineBreaks)
  if (contained) {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      appendSelectionText(child, range, out, true)
    }
  } else {
    appendSelectedChildren(node, range, out)
  }
  out.lineBreaks = Math.max(out.lineBreaks, node.tagName === 'P' ? 2 : lineBreaks)
}

function keepsWhiteSpace(element: Element, cache: Map<Element, boolean>): boolean {
  let keeps = cache.get(element)
  if (keeps === undefined) {
    keeps = /^(pre|break-spaces)/.test(getComputedStyle(element).whiteSpace)
    cache.set(element, keeps)
  }
  return keeps
}

function appendText(out: SelectionText, value: string): void {
  if (!value) {
    return
  }
  if (out.lastChar) {
    // A line already ended by a br or preserved newline needs one newline fewer.
    const lineBreaks = out.lineBreaks - (out.lastChar === '\n' ? 1 : 0)
    if (lineBreaks > 0) {
      out.parts.push('\n'.repeat(lineBreaks))
    } else if (out.space && out.lastChar !== '\t' && out.lastChar !== '\n') {
      out.parts.push(' ')
    }
  }
  out.parts.push(value)
  out.lastChar = value.slice(-1)
  out.lineBreaks = 0
  out.space = false
}
