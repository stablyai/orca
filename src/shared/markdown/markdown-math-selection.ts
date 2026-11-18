const selectionBlockTags = new Set([
  'BLOCKQUOTE',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'OL',
  'P',
  'PRE',
  'TABLE',
  'TBODY',
  'TFOOT',
  'THEAD',
  'TR',
  'UL'
])
const selectionParagraphTags = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P'])

class SelectionTextWriter {
  private readonly chunks: string[] = []
  private pendingLines = 0
  private trailingLines = 0
  hasContent = false

  append(text: string): void {
    if (!text) {
      return
    }
    if (this.pendingLines) {
      const separator = '\n'.repeat(this.pendingLines)
      this.chunks.push(separator)
      this.trailingLines += this.pendingLines
      this.pendingLines = 0
    }
    this.chunks.push(text)
    this.hasContent = true
    let trailingLines = 0
    for (let index = text.length - 1; index >= 0 && text[index] === '\n'; index -= 1) {
      trailingLines += 1
    }
    this.trailingLines =
      trailingLines === text.length ? this.trailingLines + trailingLines : trailingLines
  }

  separate(lines: number): void {
    this.pendingLines = Math.max(this.pendingLines, lines - this.trailingLines)
  }

  finish(): string {
    return this.chunks.join('')
  }
}

function isFormattingWhitespace(node: Text): boolean {
  if (node.data.trim()) {
    return false
  }
  const nextBoundary = (direction: 'previousSibling' | 'nextSibling'): boolean => {
    for (let sibling = node[direction]; sibling; sibling = sibling[direction]) {
      if (sibling.nodeType === Node.TEXT_NODE && !(sibling.textContent ?? '').trim()) {
        continue
      }
      return sibling.nodeType === Node.ELEMENT_NODE && selectionBlockTags.has(sibling.nodeName)
    }
    return false
  }
  return nextBoundary('previousSibling') || nextBoundary('nextSibling')
}

function writeSelectionNode(node: Node, writer: SelectionTextWriter, insideListItem = false): void {
  if (node instanceof Text) {
    if (!isFormattingWhitespace(node)) {
      writer.append(node.data)
    }
    return
  }
  if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    node.childNodes.forEach((child) => writeSelectionNode(child, writer, insideListItem))
    return
  }
  if (!(node instanceof Element)) {
    return
  }

  const element = node
  if (element.tagName === 'BR') {
    writer.append('\n')
    return
  }
  if (element.tagName === 'PRE') {
    if (writer.hasContent) {
      writer.separate(1)
    }
    writer.append(element.textContent ?? '')
    writer.separate(1)
    return
  }
  if (element.tagName === 'TR') {
    const cells = Array.from(element.children).filter(
      (child) => child.tagName === 'TD' || child.tagName === 'TH'
    )
    cells.forEach((cell, index) => {
      const cellWriter = new SelectionTextWriter()
      cell.childNodes.forEach((child) => writeSelectionNode(child, cellWriter))
      writer.append(cellWriter.finish())
      if (index < cells.length - 1) {
        writer.append('\t')
      }
    })
    writer.separate(1)
    return
  }

  const isLeafDiv =
    element.tagName === 'DIV' &&
    !Array.from(element.children).some((child) => selectionBlockTags.has(child.tagName))
  const paragraphLines = insideListItem ? 1 : 2
  if (selectionParagraphTags.has(element.tagName) && writer.hasContent) {
    writer.separate(1)
  } else if ((element.tagName === 'LI' || isLeafDiv) && writer.hasContent) {
    writer.separate(1)
  } else if ((element.tagName === 'UL' || element.tagName === 'OL') && insideListItem) {
    writer.separate(1)
  }
  const childInsideListItem = insideListItem || element.tagName === 'LI'
  element.childNodes.forEach((child) => writeSelectionNode(child, writer, childInsideListItem))
  if (selectionParagraphTags.has(element.tagName)) {
    writer.separate(paragraphLines)
  } else if (element.tagName === 'LI' || isLeafDiv) {
    writer.separate(1)
  }
}

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
  const fragment = range.cloneContents()
  fragment.querySelectorAll<HTMLElement>('[data-math-source]').forEach((element) => {
    element.replaceWith(element.dataset.mathSource ?? '')
  })
  fragment
    .querySelectorAll(
      '.select-none, .sr-only, [aria-hidden="true"], button, input, script, style, svg'
    )
    .forEach((element) => element.remove())
  const writer = new SelectionTextWriter()
  writeSelectionNode(fragment, writer)
  return writer.finish()
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
