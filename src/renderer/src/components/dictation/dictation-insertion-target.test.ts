// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { captureInsertionTarget, registerDictationInputOwner } from './dictation-insertion-target'

const releases: (() => void)[] = []

afterEach(() => {
  releases.splice(0).forEach((release) => release())
  document.body.innerHTML = ''
})

function pane(id: string, parent: HTMLElement = document.body) {
  const root = document.createElement('div')
  root.tabIndex = -1
  root.id = id
  const button = document.createElement('button')
  const input = document.createElement('textarea')
  root.append(button, input)
  parent.append(root)
  return { root, button, input }
}

function own(
  target: { root: HTMLElement; input: HTMLTextAreaElement },
  ownsOutsideFocus?: (active: Element | null) => boolean
): void {
  releases.push(
    registerDictationInputOwner(target.root, {
      focusInput: () => target.input.focus(),
      ownsOutsideFocus
    })
  )
}

it('sends dictation from a focused panel control to that panel’s input, not the claiming chat', () => {
  const chat = pane('chat')
  const panel = pane('panel')
  own(chat, () => true)
  own(panel)
  panel.button.focus()

  expect(captureInsertionTarget()).toEqual({ kind: 'text', element: panel.input })
})

it('picks the innermost owner when one panel sits inside another', () => {
  const chat = pane('chat')
  const panel = pane('panel', chat.root)
  own(chat)
  own(panel)
  panel.root.focus()

  expect(captureInsertionTarget()).toEqual({ kind: 'text', element: panel.input })
})

it('lets an owner claim focus outside every owner', () => {
  const chat = pane('chat')
  const panel = pane('panel')
  own(panel)
  own(chat, (active) => active === document.body)
  panel.button.focus()
  panel.button.blur()

  expect(captureInsertionTarget()).toEqual({ kind: 'text', element: chat.input })
})
