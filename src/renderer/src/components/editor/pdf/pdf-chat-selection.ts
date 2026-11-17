import type { QuotableSelection } from '../../native-chat/selection-quotes/SelectionAddToChatPopover'

export function readPdfChatSelection(
  root: HTMLElement,
  relativePath: string
): QuotableSelection | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
    return null
  }
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) {
    return null
  }
  const text = selection.toString().trim()
  if (!text) {
    return null
  }
  const pages = new Set<number>()
  const container = range.commonAncestorContainer
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  for (
    let node: Node | null = container instanceof Text ? container : walker.nextNode();
    node;
    node = walker.nextNode()
  ) {
    if (!(node instanceof Text) || !range.intersectsNode(node)) {
      continue
    }
    const start = node === range.startContainer ? range.startOffset : 0
    const end = node === range.endContainer ? range.endOffset : node.length
    if (!node.data.slice(start, end).trim()) {
      continue
    }
    const layer = node.parentElement?.closest('.textLayer')
    const page = layer?.closest<HTMLElement>('.page[data-page-number]')
    const number = Number(page?.dataset.pageNumber)
    if (!page || !root.contains(page) || !Number.isInteger(number) || number < 1) {
      return null
    }
    pages.add(number)
  }
  if (pages.size === 0) {
    return null
  }
  const label = pages.size === 1 ? 'page' : 'pages'
  return { text: `${relativePath} (${label} ${[...pages].join(', ')})\n${text}`, range }
}
