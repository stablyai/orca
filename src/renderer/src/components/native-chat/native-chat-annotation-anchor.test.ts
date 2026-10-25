// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  readNativeChatAnnotationAnchor,
  resolveNativeChatAnnotationRange
} from './native-chat-annotation-anchor'

afterEach(() => {
  document.body.replaceChildren()
  window.getSelection()?.removeAllRanges()
})

function reply(root: HTMLElement, id: string, parts: string[], quotable = true): HTMLElement {
  const row = document.createElement('div')
  row.dataset.nativeChatMessageId = id
  const source = document.createElement('div')
  if (quotable) {
    source.dataset.nativeChatQuoteSource = ''
  }
  for (const part of parts) {
    const span = document.createElement('span')
    span.textContent = part
    source.append(span)
  }
  row.append(source)
  root.append(row)
  return source
}

function selection(source: HTMLElement, start: number, end: number): Range {
  const text = source.firstChild?.firstChild
  if (!text) {
    throw new Error('Missing text')
  }
  const range = document.createRange()
  range.setStart(text, start)
  range.setEnd(text, end)
  return range
}

describe('native chat annotation anchors', () => {
  it('anchors an assistant reply before its copy controls become available', () => {
    const root = document.createElement('div')
    const source = reply(root, 'working-reply', ['control signal'])
    source.parentElement?.removeAttribute('data-native-chat-message-id')
    source.parentElement?.setAttribute('data-native-chat-annotation-message-id', 'working-reply')
    const anchor = readNativeChatAnnotationAnchor(root, selection(source, 0, 7))
    expect(anchor).toEqual({ messageId: 'working-reply', quote: 'control', startOffset: 0 })
    if (!anchor) {
      throw new Error('Missing anchor')
    }
    expect(resolveNativeChatAnnotationRange(root, anchor)?.toString()).toBe('control')
  })

  it('captures a cloned range after selection is gone and resolves the repeated quote in its original message', () => {
    const root = document.createElement('div')
    document.body.append(root)
    reply(root, 'first', ['same same'])
    const source = reply(root, 'second', ['same same'])
    const range = selection(source, 5, 9).cloneRange()
    const anchor = readNativeChatAnnotationAnchor(root, range)
    expect(anchor).toEqual({ messageId: 'second', quote: 'same', startOffset: 5 })
    if (!anchor) {
      throw new Error('Missing anchor')
    }
    const resolved = resolveNativeChatAnnotationRange(root, anchor)
    expect(resolved?.startContainer).toBe(source.firstChild?.firstChild)
    expect(resolved?.startOffset).toBe(5)
    expect(resolved?.toString()).toBe('same')
  })

  it('round trips a selection split across inline elements and trims with the correct offset', () => {
    const root = document.createElement('div')
    const source = reply(root, 'inline', ['  hello ', 'world  '])
    const range = document.createRange()
    range.selectNodeContents(source)
    const anchor = readNativeChatAnnotationAnchor(root, range)
    expect(anchor).toEqual({ messageId: 'inline', quote: 'hello world', startOffset: 2 })
    if (!anchor) {
      throw new Error('Missing anchor')
    }
    expect(resolveNativeChatAnnotationRange(root, anchor)?.toString()).toBe('hello world')
  })

  it('rejects cross-message ranges, user text, collapsed ranges and other roots', () => {
    const root = document.createElement('div')
    const first = reply(root, 'one', ['hello'])
    const second = reply(root, 'two', ['world'])
    const user = reply(root, 'user', ['my prompt'], false)
    const range = selection(first, 1, 4)
    const end = second.firstChild?.firstChild
    if (!end) {
      throw new Error('Missing text')
    }
    range.setEnd(end, 2)
    expect(readNativeChatAnnotationAnchor(root, range)).toBeNull()
    expect(readNativeChatAnnotationAnchor(root, selection(user, 0, 2))).toBeNull()
    expect(readNativeChatAnnotationAnchor(root, selection(first, 1, 1))).toBeNull()
    expect(
      readNativeChatAnnotationAnchor(document.createElement('div'), selection(first, 0, 3))
    ).toBeNull()
  })

  it('uses offsets across sources in a message and does not use a different message for stale text', () => {
    const root = document.createElement('div')
    const first = reply(root, 'original', ['prefix '])
    const second = document.createElement('p')
    second.dataset.nativeChatQuoteSource = ''
    second.append(document.createElement('span'))
    second.firstChild?.appendChild(document.createTextNode('target'))
    first.parentElement?.append(second)
    const anchor = readNativeChatAnnotationAnchor(root, selection(second, 0, 6))
    expect(anchor).toEqual({ messageId: 'original', quote: 'target', startOffset: 7 })
    if (!anchor) {
      throw new Error('Missing anchor')
    }
    expect(resolveNativeChatAnnotationRange(root, anchor)?.toString()).toBe('target')
    first.textContent = 'longer prefix '
    reply(root, 'other', ['prefix target'])
    expect(resolveNativeChatAnnotationRange(root, anchor)).toBeNull()
    expect(resolveNativeChatAnnotationRange(root, { ...anchor, messageId: 'missing' })).toBeNull()
  })

  it('returns null after the saved occurrence changes even if the same words remain elsewhere', () => {
    const root = document.createElement('div')
    const source = reply(root, 'stale', ['target target'])
    const anchor = readNativeChatAnnotationAnchor(root, selection(source, 7, 13))
    if (!anchor) {
      throw new Error('Missing anchor')
    }
    source.textContent = 'target changed target'
    expect(resolveNativeChatAnnotationRange(root, anchor)).toBeNull()
  })

  it('captures triple-click ranges ending after unselectable timestamps or at the next reply start', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const source = reply(root, 'triple', ['  selected words  '])
    const timestamp = document.createElement('span')
    timestamp.style.userSelect = 'none'
    timestamp.textContent = '12:34'
    source.parentElement?.append(timestamp)
    const next = reply(root, 'next', ['another reply'])
    const range = document.createRange()
    range.selectNodeContents(root)
    const text = source.firstChild?.firstChild
    if (!text) {
      throw new Error('Missing text')
    }
    range.setStart(text, 0)
    range.setEnd(timestamp, 1)
    const anchor = { messageId: 'triple', quote: 'selected words', startOffset: 2 }
    expect(readNativeChatAnnotationAnchor(root, range)).toEqual(anchor)
    expect(resolveNativeChatAnnotationRange(root, anchor)?.toString()).toBe('selected words')
    const nextText = next.firstChild?.firstChild
    if (!nextText) {
      throw new Error('Missing next text')
    }
    range.setEnd(nextText, 0)
    expect(readNativeChatAnnotationAnchor(root, range)).toEqual(anchor)
    range.setEnd(nextText, 1)
    expect(readNativeChatAnnotationAnchor(root, range)).toBeNull()
  })

  it('reads the current browser selection when no range is passed', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const source = reply(root, 'browser-selection', ['select this'])
    window.getSelection()?.addRange(selection(source, 7, 11))
    expect(readNativeChatAnnotationAnchor(root)).toEqual({
      quote: 'this',
      messageId: 'browser-selection',
      startOffset: 7
    })
  })
})
