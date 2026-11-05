import type { ClipboardEvent } from 'react'

/** A selected equation copies once as TeX instead of KaTeX's duplicated visual/MathML text. */
export function chatMathSelectionText(selection: Selection, root: Element): string | null {
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
  fragment.querySelectorAll('br').forEach((element) => element.replaceWith('\n'))
  fragment.querySelectorAll('p,div,blockquote,pre,li,tr,h1,h2,h3,h4,h5,h6').forEach((element) => {
    element.after(element.tagName === 'P' ? '\n\n' : '\n')
  })
  return (fragment.textContent ?? '').replace(/\n{3,}/g, '\n\n').trimEnd()
}

export function copyChatMathSelection(event: ClipboardEvent<HTMLDivElement>): void {
  if (event.defaultPrevented) {
    return
  }
  const selection = event.currentTarget.ownerDocument.getSelection()
  const text = selection && chatMathSelectionText(selection, event.currentTarget)
  if (text === null || text === undefined) {
    return
  }
  event.clipboardData.setData('text/plain', text)
  event.clipboardData.setData('text/html', '')
  event.preventDefault()
}
