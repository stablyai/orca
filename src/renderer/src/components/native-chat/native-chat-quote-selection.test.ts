// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { readNativeChatQuotableSelection } from '../../../../shared/native-chat/input/quotes/native-chat-quote-selection'
import { readNativeChatTranscriptSelection } from './selection-quotes/native-chat-transcript-selection'

const KEY = 'orcawh_secretsecretsecret'

function transcript(): { root: HTMLElement; before: Text; after: Text; key: Text } {
  const root = document.createElement('div')
  root.innerHTML = `
    <div data-native-chat-scroll>
      <div data-native-chat-quote-source>
        <p id="before">Copy the URL from the card.</p>
        <div data-native-chat-secret data-native-chat-find-skip><span id="key">${KEY}</span></div>
        <p id="after">I’ll show you the first call.</p>
      </div>
    </div>`
  document.body.append(root)
  const text = (id: string): Text => {
    const node = root.querySelector(`#${id}`)?.firstChild
    if (!(node instanceof Text)) {
      throw new Error(`no text in #${id}`)
    }
    return node
  }
  return { root, before: text('before'), after: text('after'), key: text('key') }
}

function select(start: Text, end: Text): void {
  const range = document.createRange()
  range.setStart(start, 0)
  range.setEnd(end, end.length)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

afterEach(() => {
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

describe('native chat selections around a secret-bearing control', () => {
  it('quotes the prose around a revealed key, never the key', () => {
    const { root, before, after } = transcript()
    select(before, after)
    const quote = readNativeChatQuotableSelection(root)
    expect(quote?.text).toContain('Copy the URL from the card.')
    expect(quote?.text).toContain('I’ll show you the first call.')
    expect(quote?.text).not.toContain(KEY)
    expect(readNativeChatTranscriptSelection(root)).not.toContain(KEY)
  })

  it('offers nothing to quote or copy when only the key is selected', () => {
    const { root, key } = transcript()
    select(key, key)
    expect(readNativeChatQuotableSelection(root)).toBeNull()
    expect(readNativeChatTranscriptSelection(root)).not.toContain(KEY)
  })
})
