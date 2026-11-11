// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

import { shouldHandleAutomationRunHistoryKey } from './automation-run-history-keyboard-navigation'

describe('shouldHandleAutomationRunHistoryKey', () => {
  function makeEvent(
    overrides: Partial<{
      key: string
      altKey: boolean
      ctrlKey: boolean
      metaKey: boolean
      shiftKey: boolean
      isComposing: boolean
      target: EventTarget | null
    }> = {}
  ) {
    return {
      key: 'ArrowDown',
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      nativeEvent: { isComposing: overrides.isComposing ?? false },
      target: overrides.target ?? document.body,
      ...overrides
    }
  }

  it('ignores modified or composing keys', () => {
    expect(shouldHandleAutomationRunHistoryKey(makeEvent({ metaKey: true }))).toBe(false)
    expect(shouldHandleAutomationRunHistoryKey(makeEvent({ ctrlKey: true }))).toBe(false)
    expect(shouldHandleAutomationRunHistoryKey(makeEvent({ altKey: true }))).toBe(false)
    expect(shouldHandleAutomationRunHistoryKey(makeEvent({ shiftKey: true }))).toBe(false)
    expect(shouldHandleAutomationRunHistoryKey(makeEvent({ isComposing: true }))).toBe(false)
  })

  it('ignores an IME-owned native Enter from the window listener but handles the committed one', () => {
    const composingEnter = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true })
    const processEnter = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229 })
    const committedEnter = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13 })
    expect(shouldHandleAutomationRunHistoryKey(composingEnter)).toBe(false)
    expect(shouldHandleAutomationRunHistoryKey(processEnter)).toBe(false)
    expect(shouldHandleAutomationRunHistoryKey(committedEnter)).toBe(true)
  })

  it('ignores keys when target is an editable input element or inside a modal dialog', () => {
    const input = document.createElement('input')
    expect(shouldHandleAutomationRunHistoryKey(makeEvent({ target: input }))).toBe(false)

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const button = document.createElement('button')
    dialog.appendChild(button)
    document.body.appendChild(dialog)

    expect(shouldHandleAutomationRunHistoryKey(makeEvent({ target: button }))).toBe(false)

    dialog.remove()
  })

  it('leaves Enter to a focused button or link but still handles arrows there', () => {
    const button = document.createElement('button')
    const link = document.createElement('a')
    link.setAttribute('href', '#')

    expect(shouldHandleAutomationRunHistoryKey(makeEvent({ key: 'Enter', target: button }))).toBe(
      false
    )
    expect(shouldHandleAutomationRunHistoryKey(makeEvent({ key: 'Enter', target: link }))).toBe(
      false
    )

    const tabTrigger = document.createElement('div')
    tabTrigger.setAttribute('role', 'tab')
    expect(
      shouldHandleAutomationRunHistoryKey(makeEvent({ key: 'Enter', target: tabTrigger }))
    ).toBe(false)

    expect(
      shouldHandleAutomationRunHistoryKey(makeEvent({ key: 'ArrowDown', target: button }))
    ).toBe(true)
  })
})
