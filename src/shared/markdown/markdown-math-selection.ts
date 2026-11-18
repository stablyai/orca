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
const collapsibleWhitespace = /^[\t\n\r ]*$/

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
    if (this.hasContent) {
      this.pendingLines = Math.max(this.pendingLines, lines - this.trailingLines)
    }
  }

  finish(): string {
    return this.chunks.join('')
  }
}

function isFormattingWhitespace(node: Text): boolean {
  if (!collapsibleWhitespace.test(node.data)) {
    return false
  }
  const nextBoundary = (direction: 'previousSibling' | 'nextSibling'): boolean => {
    for (let sibling = node[direction]; sibling; sibling = sibling[direction]) {
      if (
        sibling.nodeType === Node.TEXT_NODE &&
        collapsibleWhitespace.test(sibling.textContent ?? '')
      ) {
        continue
      }
      return sibling.nodeType === Node.ELEMENT_NODE && selectionBlockTags.has(sibling.nodeName)
    }
    return false
  }
  return nextBoundary('previousSibling') || nextBoundary('nextSibling')
}

function textEndsAtBlockBoundary(node: Text): boolean {
  for (let current: Node = node; current.parentNode; current = current.parentNode) {
    for (let sibling = current.nextSibling; sibling; sibling = sibling.nextSibling) {
      if (
        sibling.nodeType === Node.COMMENT_NODE ||
        (sibling.nodeType === Node.TEXT_NODE &&
          collapsibleWhitespace.test(sibling.textContent ?? ''))
      ) {
        continue
      }
      return (
        sibling.nodeType === Node.ELEMENT_NODE &&
        (selectionBlockTags.has(sibling.nodeName) || sibling.nodeName === 'BR')
      )
    }
    const parent = current.parentNode
    if (
      parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE ||
      (parent instanceof Element &&
        (selectionBlockTags.has(parent.tagName) ||
          parent.tagName === 'TD' ||
          parent.tagName === 'TH'))
    ) {
      return true
    }
  }
  return true
}

function writeSelectionNode(
  node: Node,
  writer: SelectionTextWriter,
  insideListItem = false,
  selectedTrailingText?: Text
): void {
  if (node instanceof Text) {
    if (!isFormattingWhitespace(node)) {
      let end = node.data.length
      if (
        node !== selectedTrailingText &&
        end &&
        (node.data[end - 1] === ' ' || node.data[end - 1] === '\t')
      ) {
        if (textEndsAtBlockBoundary(node)) {
          while (end && (node.data[end - 1] === ' ' || node.data[end - 1] === '\t')) {
            end -= 1
          }
        }
      }
      writer.append(node.data.slice(0, end))
    }
    return
  }
  if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    node.childNodes.forEach((child) =>
      writeSelectionNode(child, writer, insideListItem, selectedTrailingText)
    )
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
      cell.childNodes.forEach((child) =>
        writeSelectionNode(child, cellWriter, false, selectedTrailingText)
      )
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
  const isLineBlock = element.tagName === 'BLOCKQUOTE' || element.tagName === 'LI' || isLeafDiv
  const paragraphLines = insideListItem ? 1 : 2
  if (selectionParagraphTags.has(element.tagName) && writer.hasContent) {
    writer.separate(1)
  } else if (isLineBlock && writer.hasContent) {
    writer.separate(1)
  } else if ((element.tagName === 'UL' || element.tagName === 'OL') && insideListItem) {
    writer.separate(1)
  }
  const childInsideListItem = insideListItem || element.tagName === 'LI'
  element.childNodes.forEach((child) =>
    writeSelectionNode(child, writer, childInsideListItem, selectedTrailingText)
  )
  if (selectionParagraphTags.has(element.tagName)) {
    writer.separate(paragraphLines)
  } else if (isLineBlock) {
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
  const preserveTrailingRangeSpace =
    range.endContainer instanceof Text &&
    (range.endOffset < range.endContainer.length || !textEndsAtBlockBoundary(range.endContainer))
  const fragment = range.cloneContents()
  fragment.querySelectorAll<HTMLElement>('[data-math-source]').forEach((element) => {
    element.replaceWith(element.dataset.mathSource ?? '')
  })
  fragment
    .querySelectorAll(
      '.select-none, .sr-only, [aria-hidden="true"], button, input, script, style, svg'
    )
    .forEach((element) => element.remove())
  let selectedTrailingText: Text | undefined
  if (preserveTrailingRangeSpace) {
    const walker = root.ownerDocument.createTreeWalker(fragment, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node instanceof Text) {
        selectedTrailingText = node
      }
    }
  }
  let selectionRoot: Node = fragment
  if (container.tagName === 'TR') {
    const row = root.ownerDocument.createElement('tr')
    row.append(fragment)
    selectionRoot = row
  }
  const writer = new SelectionTextWriter()
  writeSelectionNode(selectionRoot, writer, false, selectedTrailingText)
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
