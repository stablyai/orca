// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { returnWorkerDockFocus } from './worker-dock-focus-return'

function pane(): { root: HTMLElement; editor: HTMLElement } {
  const root = document.createElement('div')
  root.setAttribute('data-native-chat-root', '')
  const editor = document.createElement('div')
  editor.setAttribute('data-native-chat-prompt-editor', 'true')
  editor.tabIndex = 0
  root.append(editor)
  document.body.append(root)
  return { root, editor }
}

afterEach(() => {
  document.body.replaceChildren()
})

it('sends focus that fell to the page to the pane editor once the row and pill are gone', () => {
  const two = pane()
  returnWorkerDockFocus(document.createElement('button'), two.root)
  expect(document.activeElement).toBe(two.editor)
})

it('keeps focus the user moved into another pane before the dialog handed it back', () => {
  const one = pane()
  const two = pane()
  one.editor.focus()
  returnWorkerDockFocus(document.createElement('button'), two.root)
  expect(document.activeElement).toBe(one.editor)
})

it('returns focus to a connected opener when focus fell to the page', () => {
  const two = pane()
  const opener = document.createElement('button')
  two.root.append(opener)
  returnWorkerDockFocus(opener, two.root)
  expect(document.activeElement).toBe(opener)
})
