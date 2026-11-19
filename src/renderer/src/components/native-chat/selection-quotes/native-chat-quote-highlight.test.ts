// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  placeRange,
  quotePlace,
  quotedTextRange,
  showQuotedText
} from './native-chat-quote-highlight'

const highlights = new Map<string, { range: Range }>()

beforeEach(() => {
  vi.useFakeTimers()
  highlights.clear()
  vi.stubGlobal('CSS', { highlights })
  vi.stubGlobal(
    'Highlight',
    class {
      constructor(readonly range: Range) {}
    }
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function element(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.append(root)
  for (const child of [root, ...root.querySelectorAll('*')]) {
    if (child instanceof HTMLElement) {
      child.scrollIntoView = vi.fn()
    }
  }
  return root
}

/** The range a user selects: `from` to `to` in the text of `root`. */
function selected(root: HTMLElement, from: number, to: number): Range {
  const range = document.createRange()
  let start = from
  let end = to
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const { length } = node.textContent ?? ''
    if (start >= 0 && start < length) {
      range.setStart(node, start)
    }
    if (end >= 0 && end <= length) {
      range.setEnd(node, end)
      break
    }
    start -= length
    end -= length
  }
  return range
}

const shown = () => highlights.get('native-chat-quote-jump')?.range

it('highlights the word the user selected, not an earlier match inside another word', () => {
  const root = element('<p>Use concatenate, then cat the file.</p>')
  const at = 'Use concatenate, then '.length
  const place = quotePlace(root, selected(root, at, at + 3))
  showQuotedText(root, 'cat', place)
  expect(shown()?.toString()).toBe('cat')
  expect(shown()?.startOffset).toBe(at)
})

it('highlights the second of two equal phrases when the user selected the second', () => {
  const root = element('<p>the end.</p><p>More text, <em>the end.</em></p>')
  const at = 'the end.More text, '.length
  showQuotedText(root, 'the end.', quotePlace(root, selected(root, at, at + 8)))
  expect(shown()?.startContainer.parentElement?.tagName).toBe('EM')
})

it('highlights a quote with digits, symbols and Markdown marks at its place', () => {
  const root = element('<h1>a comment</h1><ul><li>v1.2 &amp; C++ removed</li></ul>')
  const text = root.textContent ?? ''
  const place = quotePlace(root, selected(root, 0, text.length))
  showQuotedText(root, 'a comment\nv1.2 & C++ removed', place)
  expect(shown()?.toString()).toBe('a commentv1.2 & C++ removed')
  expect(document.activeElement).toBe(root)
})

it('searches for the quote when the reply changed since, and skips only whitespace', () => {
  const root = element('<p>Old words. The <strong>quoted</strong>\ntext here.</p>')
  const place = quotePlace(root, selected(root, 0, 3))
  root.querySelector('p')!.prepend('New: ')
  expect(placeRange(root, place)).toBeNull()
  showQuotedText(root, 'The quoted text', place)
  expect(shown()?.toString()).toBe('The quoted\ntext')
  expect(quotedTextRange(root, 'The quotedtext!')).toBeNull()
})

it('finds a quote with no saved place as a whole word, not inside a longer word', () => {
  const root = element('<p>Use bobcat, then cat the file.</p>')
  showQuotedText(root, 'cat', null)
  expect(shown()?.startOffset).toBe('Use bobcat, then '.length)
})

it('keeps the part of a selection that is in the reply when it starts before the reply', () => {
  const page = element('<p>Your prompt</p><div data-reply="">The reply text.</div>')
  const reply = page.querySelector<HTMLElement>('[data-reply]')!
  const range = document.createRange()
  range.setStart(page.querySelector('p')!.firstChild!, 5)
  range.setEnd(reply.firstChild!, 'The reply'.length)
  const place = quotePlace(reply, range)
  expect(place.offset).toBe(0)
  expect(placeRange(reply, place)?.toString()).toBe('The reply')
})
