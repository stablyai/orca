// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'

import { markdownMathSelectionText } from './markdown-math-selection'

afterEach(() => {
  document.body.replaceChildren()
  document.getSelection()?.removeAllRanges()
})

it('copies partial math selections with semantic block boundaries', () => {
  document.body.innerHTML = `<div id="root">
    <div>
      <div>
        <p>prefix Inline math <span data-math-source="$x^2$">x²</span> appears here.</p>
        <blockquote><p>quoted one</p><p>quoted two</p></blockquote>
        <div><span>leaf one</span></div>
        <div><span>hello</span> <span>world</span></div>
        <ul>
          <li>parent<ul><li>child</li></ul></li>
          <li><div><p>next</p></div></li>
        </ul>
        <table><tbody><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></tbody></table>
        <pre>line a  \n\n\nline d  </pre>
        <p>Done<br>tail. suffix</p>
      </div>
    </div>
  </div>`
  const root = document.querySelector('#root')
  const paragraphs = root?.querySelectorAll('p')
  const first = paragraphs?.item(0).firstChild
  const last = paragraphs?.item((paragraphs?.length ?? 1) - 1).lastChild
  if (!(root instanceof Element) || !(first instanceof Text) || !(last instanceof Text)) {
    throw new Error('Missing selection fixture')
  }
  const range = document.createRange()
  range.setStart(first, 'prefix '.length)
  range.setEnd(last, 'tail.'.length)
  const selection = document.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)

  expect(selection && markdownMathSelectionText(selection, root)).toBe(
    'Inline math $x^2$ appears here.\n\nquoted one\n\nquoted two\n\nleaf one\nhello world\nparent\nchild\nnext\nA\tB\nC\tD\nline a  \n\n\nline d  \nDone\ntail.'
  )
})

it('keeps trailing empty table cells', () => {
  document.body.innerHTML = `<div id="root"><p><span data-math-source="$x$">x</span></p><table><tbody><tr><td>A</td><td></td><td></td></tr><tr><td>B</td><td></td><td></td></tr></tbody></table></div>`
  const root = document.querySelector('#root')
  if (!(root instanceof Element)) {
    throw new Error('Missing table fixture')
  }
  const range = document.createRange()
  range.selectNodeContents(root)
  const selection = document.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)

  expect(selection && markdownMathSelectionText(selection, root)).toBe('$x$\n\nA\t\t\nB\t\t')
})

it('keeps selected trailing whitespace in code and explicit line breaks', () => {
  document.body.innerHTML = `<div id="root"><p><span data-math-source="$x$">x</span></p><pre>code  \n\nend  \n\n</pre><p>last<br></p></div>`
  const root = document.querySelector('#root')
  const first = root?.firstElementChild
  const preText = root?.querySelector('pre')?.firstChild
  const lineBreak = root?.querySelector('br')
  if (
    !(root instanceof Element) ||
    !(first instanceof Element) ||
    !(preText instanceof Text) ||
    !(lineBreak instanceof HTMLBRElement)
  ) {
    throw new Error('Missing trailing whitespace fixture')
  }
  const range = document.createRange()
  range.setStartBefore(first)
  range.setEnd(preText, preText.length)
  const selection = document.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  expect(selection && markdownMathSelectionText(selection, root)).toBe('$x$\n\ncode  \n\nend  \n\n')

  range.setEndAfter(lineBreak)
  selection?.removeAllRanges()
  selection?.addRange(range)
  expect(selection && markdownMathSelectionText(selection, root)).toBe(
    '$x$\n\ncode  \n\nend  \n\nlast\n'
  )
})

it('drops collapsible block-end spaces but keeps nonbreaking and inline spaces', () => {
  document.body.innerHTML = `<div id="root"><div><button>Copy</button></div><p><span data-math-source="$x$">x</span></p><p>First&nbsp;  </p><p>Before  <br>After</p><table><tbody><tr><td>A  </td><td>B</td></tr></tbody></table><blockquote>quoted  </blockquote><span>tail</span></div>`
  const root = document.querySelector('#root')
  if (!(root instanceof Element)) {
    throw new Error('Missing normal whitespace fixture')
  }
  const range = document.createRange()
  range.selectNodeContents(root)
  const selection = document.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)

  expect(selection && markdownMathSelectionText(selection, root)).toBe(
    '$x$\n\nFirst\u00a0\n\nBefore\nAfter\n\nA\tB\nquoted\ntail'
  )
})

it('keeps tabs when a partial selection spans table cells', () => {
  document.body.innerHTML = `<table id="root"><tbody><tr><td>prefix <span data-math-source="$x$">x</span> A</td><td>B</td><td>C suffix</td></tr></tbody></table>`
  const root = document.querySelector('#root')
  const row = root?.querySelector('tr')
  const first = row?.firstElementChild?.firstChild
  const last = row?.lastElementChild?.firstChild
  if (!(root instanceof Element) || !(first instanceof Text) || !(last instanceof Text)) {
    throw new Error('Missing partial table fixture')
  }
  const range = document.createRange()
  range.setStart(first, 'prefix '.length)
  range.setEnd(last, 'C'.length)
  const selection = document.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)

  expect(selection && markdownMathSelectionText(selection, root)).toBe('$x$ A\tB\tC')
})

it('keeps a selected space before unselected inline text', () => {
  document.body.innerHTML = `<p id="root"><span data-math-source="$x$">x</span> Hello world</p>`
  const root = document.querySelector('#root')
  const first = root?.firstElementChild
  const text = root?.lastChild
  if (!(root instanceof Element) || !(first instanceof Element) || !(text instanceof Text)) {
    throw new Error('Missing partial inline fixture')
  }
  const range = document.createRange()
  range.setStartBefore(first)
  range.setEnd(text, ' Hello '.length)
  const selection = document.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)

  expect(selection && markdownMathSelectionText(selection, root)).toBe('$x$ Hello ')
})
