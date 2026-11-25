// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import {
  closeNativeChatSubagentOnEscape,
  noteNativeChatSubagentParent,
  openNativeChatSubagent,
  takeNativeChatSubagentOpener
} from './native-chat-open-subagent'

const PANE = 'tab-1:pane'

afterEach(() => {
  openNativeChatSubagent(PANE, null)
  takeNativeChatSubagentOpener(PANE)
  document.body.innerHTML = ''
})

function pressEscape(currentTarget: HTMLElement, target: HTMLElement): boolean {
  let prevented = false
  closeNativeChatSubagentOnEscape(
    {
      key: 'Escape',
      defaultPrevented: false,
      target,
      currentTarget,
      preventDefault: () => {
        prevented = true
      }
    },
    PANE
  )
  return prevented
}

it('goes up one level on Esc from inside the subagent sheet, then closes it', () => {
  document.body.innerHTML =
    '<div id="sheet" role="dialog" data-native-chat-subagent-sheet><button id="x"></button></div>'
  const sheet = document.getElementById('sheet')!
  const button = document.getElementById('x')!
  openNativeChatSubagent(PANE, 'parent')
  openNativeChatSubagent(PANE, 'child')
  noteNativeChatSubagentParent(PANE, 'child', 'parent')

  expect(pressEscape(sheet, button)).toBe(true)
  expect(pressEscape(sheet, button)).toBe(true)
  // Closed: nothing left for Esc to do.
  expect(pressEscape(sheet, button)).toBe(false)
})

it('leaves Esc to another dialog open inside the sheet', () => {
  document.body.innerHTML =
    '<div id="sheet" role="dialog" data-native-chat-subagent-sheet><div role="dialog"><button id="x"></button></div></div>'
  openNativeChatSubagent(PANE, 'child')

  expect(pressEscape(document.getElementById('sheet')!, document.getElementById('x')!)).toBe(false)
})

it('hands back what had focus when the sheet first opened, not when it swapped', () => {
  document.body.innerHTML = '<button id="row"></button><button id="other"></button>'
  document.getElementById('row')!.focus()
  openNativeChatSubagent(PANE, 'a1')
  document.getElementById('other')!.focus()
  openNativeChatSubagent(PANE, 'a2')

  expect(takeNativeChatSubagentOpener(PANE)).toBe(document.getElementById('row'))
})
