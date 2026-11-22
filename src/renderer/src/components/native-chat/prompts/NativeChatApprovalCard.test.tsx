// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  container.setAttribute('data-native-chat-root', 'true')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function showCard(): HTMLButtonElement {
  act(() => {
    root.render(
      <NativeChatApprovalCard
        approval={{
          title: 'Run mkdir /tmp/x?',
          options: [
            { label: 'Allow', send: 'accept' },
            { label: 'Deny', send: 'decline' }
          ]
        }}
        onChoose={() => {}}
        onCancel={() => {}}
        shouldFocus
      />
    )
  })
  return [...container.querySelectorAll('button')].find((b) => b.textContent === 'Allow')!
}

const keydown = (target: Element, key: string): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

// Enter must approve the default, and a keystroke typed as the card appeared must not.
it('focuses the default answer, but ignores Enter from a typing burst still going', () => {
  const composer = document.createElement('textarea')
  container.appendChild(composer)
  composer.focus()
  keydown(composer, 'h')
  composer.remove()

  const allow = showCard()
  expect(document.activeElement).toBe(allow)
  expect(keydown(allow, 'Enter').defaultPrevented).toBe(true)
})
