// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { readPdfChatSelection } from './pdf-chat-selection'

afterEach(() => {
  window.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

function fixture(): { root: HTMLDivElement; first: Text; second: Text; third: Text } {
  const root = document.createElement('div')
  root.innerHTML =
    '<div class="page" data-page-number="2"><div class="textLayer"><span>First page text</span></div></div><div class="page" data-page-number="3"><div class="textLayer"><span>Second page text</span></div></div><div class="page" data-page-number="4"><div class="textLayer"><span>Third page text</span></div></div>'
  document.body.append(root)
  const nodes = root.querySelectorAll('span')
  const first = nodes[0].firstChild
  const second = nodes[1].firstChild
  const third = nodes[2].firstChild
  if (!(first instanceof Text) || !(second instanceof Text) || !(third instanceof Text)) {
    throw new Error('Missing PDF fixture text')
  }
  return { root, first, second, third }
}

function select(start: Text, startOffset: number, end: Text, endOffset: number): void {
  const range = document.createRange()
  range.setStart(start, startOffset)
  range.setEnd(end, endOffset)
  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(range)
}

it('quotes the selected fragment with its PDF path and actual page number', () => {
  const { root, second } = fixture()
  select(second, 7, second, 11)
  expect(readPdfChatSelection(root, 'docs/paper.pdf')?.text).toBe('docs/paper.pdf (page 3)\npage')
})

it('includes selected pages but excludes a next-page endpoint with no selected text', () => {
  const { root, first, third } = fixture()
  select(first, 6, third, 0)
  expect(readPdfChatSelection(root, 'paper.pdf')?.text).toBe(
    'paper.pdf (pages 2, 3)\npage textSecond page text'
  )
})

it('rejects selections that cross the viewer boundary or include annotation text', () => {
  const { root, first, second } = fixture()
  const outside = document.createTextNode('Other editor')
  document.body.append(outside)
  select(first, 0, outside, 5)
  expect(readPdfChatSelection(root, 'paper.pdf')).toBeNull()
  const annotation = document.createElement('div')
  annotation.textContent = 'Annotation'
  root.firstElementChild!.append(annotation)
  select(first, 0, second, 6)
  expect(readPdfChatSelection(root, 'paper.pdf')).toBeNull()
})
