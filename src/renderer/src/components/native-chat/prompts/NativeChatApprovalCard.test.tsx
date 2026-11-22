// @vitest-environment happy-dom

import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { focusNativeChatPromptCard } from './use-native-chat-prompt-card-focus'
import { useNativeChatComposerMount } from '../composer/focus/native-chat-composer-mount'
import type { NativeChatComposerInput } from '../composer/editor/native-chat-composer-input'

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

const approval = {
  title: 'Run a command?',
  description: 'mkdir /tmp/x',
  options: [
    { label: 'Allow', send: 'accept' },
    { label: 'Deny', send: 'decline' }
  ]
}

function Composer({ draft }: { draft: string }): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  const input = useRef<NativeChatComposerInput>({
    get value() {
      return draft
    },
    contains: (node) => node === ref.current
  } as NativeChatComposerInput)
  useNativeChatComposerMount('scope', input.current, () => false, false)
  return <textarea ref={ref} autoFocus />
}

function Card(props: { placement?: 'composer' | 'stacked' }): React.JSX.Element {
  return <NativeChatApprovalCard approval={approval} onChoose={() => {}} shouldFocus {...props} />
}

const render = (node: React.ReactNode): void => act(() => root.render(node))
const allow = (): HTMLButtonElement =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === 'Allow')!
const card = (): HTMLElement => container.querySelector<HTMLElement>('[role="group"]')!

it('focuses the default answer when the card replaces an empty composer', () => {
  render(<Composer draft="" />)
  render(<Card />)
  expect(document.activeElement).toBe(allow())
})

// A keystroke meant for the draft must not press Allow.
it('keeps focus on the card when it replaces a focused composer holding a draft', () => {
  render(<Composer draft="and then" />)
  expect(document.activeElement?.tagName).toBe('TEXTAREA')
  render(<Card />)
  expect(document.activeElement).toBe(card())
})

it('describes the default answer with the request it approves', () => {
  render(<Card />)
  const id = allow().getAttribute('aria-describedby')
  expect(id && document.getElementById(id)?.textContent).toContain('mkdir /tmp/x')
})

it('never offers a stacked card to later focus handoffs', () => {
  render(<Card placement="stacked" />)
  expect(focusNativeChatPromptCard(container, null)).toBe(false)
})
