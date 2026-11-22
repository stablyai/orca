// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
  vi.restoreAllMocks()
  act(() => root.unmount())
  container.remove()
})

function showCard(key = 'a'): HTMLButtonElement {
  act(() => {
    root.render(
      <NativeChatApprovalCard
        key={key}
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

const keydown = (target: Element, key: string, at?: number): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  if (at !== undefined) {
    Object.defineProperty(event, 'timeStamp', { value: at })
  }
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

// Runs first: the typing tracker is module state, and a later test types into a field.
it('lets Enter pick the default right away when only navigation keys came before', () => {
  keydown(document.body, 'Tab')
  const allow = showCard()
  expect(document.activeElement).toBe(allow)
  expect(keydown(allow, 'Enter').defaultPrevented).toBe(false)
})

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

it('guards a card that replaces one while the burst goes on over its buttons', () => {
  const now = vi.spyOn(performance, 'now')
  const composer = document.createElement('textarea')
  container.appendChild(composer)
  keydown(composer, 'h', 10_000)
  composer.remove()
  now.mockReturnValue(10_100)
  const first = showCard('first')
  for (const at of [10_400, 10_700, 11_000, 11_300]) {
    keydown(first, 'x', at)
  }
  now.mockReturnValue(11_350)
  const second = showCard('second')
  expect(second).not.toBe(first)
  expect(keydown(second, 'Enter', 11_400).defaultPrevented).toBe(true)
})
