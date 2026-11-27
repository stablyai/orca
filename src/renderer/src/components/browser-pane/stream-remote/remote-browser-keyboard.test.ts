// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import {
  getRemoteBrowserProxyBeforeInputKey,
  takeRemoteBrowserProxyText
} from './remote-browser-keyboard'

function proxy(value = '', composing = false): HTMLTextAreaElement {
  const textarea = document.createElement('textarea')
  textarea.value = value
  if (composing) {
    textarea.dataset.composing = ''
  }
  return textarea
}

it('sends Backspace the empty proxy could not delete as a keypress', () => {
  expect(
    getRemoteBrowserProxyBeforeInputKey({
      inputType: 'deleteContentBackward',
      currentTarget: proxy()
    })
  ).toBe('Backspace')
})

it('sends Delete and Enter the empty proxy could not apply as keypresses', () => {
  expect(
    getRemoteBrowserProxyBeforeInputKey({
      inputType: 'deleteContentForward',
      currentTarget: proxy()
    })
  ).toBe('Delete')
  expect(
    getRemoteBrowserProxyBeforeInputKey({ inputType: 'insertLineBreak', currentTarget: proxy() })
  ).toBe('Enter')
  expect(
    getRemoteBrowserProxyBeforeInputKey({ inputType: 'insertParagraph', currentTarget: proxy() })
  ).toBe('Enter')
})

it('leaves the edit to the proxy once it holds text, which input forwards as typed text', () => {
  expect(
    getRemoteBrowserProxyBeforeInputKey({
      inputType: 'deleteContentBackward',
      currentTarget: proxy('abc')
    })
  ).toBeNull()
})

it('leaves the edit to the proxy while the input method composes', () => {
  expect(
    getRemoteBrowserProxyBeforeInputKey({
      inputType: 'insertLineBreak',
      currentTarget: proxy('', true)
    })
  ).toBeNull()
})

it('leaves input types that are not a key alone', () => {
  expect(
    getRemoteBrowserProxyBeforeInputKey({ inputType: 'insertText', currentTarget: proxy() })
  ).toBeNull()
})

it('ignores text that arrives while the proxy composes, even when isComposing is unset', () => {
  const textarea = proxy('ni', true)
  const taken = takeRemoteBrowserProxyText({
    nativeEvent: new InputEvent('input', { bubbles: true }),
    currentTarget: textarea
  })
  expect(taken).toBeNull()
  // The composition owns its text, so the proxy keeps it for the commit that follows.
  expect(textarea.value).toBe('ni')
})

it('takes the committed text and empties the proxy', () => {
  const textarea = proxy('你')
  expect(
    takeRemoteBrowserProxyText({
      nativeEvent: new InputEvent('input', { bubbles: true }),
      currentTarget: textarea
    })
  ).toBe('你')
  expect(textarea.value).toBe('')
})
