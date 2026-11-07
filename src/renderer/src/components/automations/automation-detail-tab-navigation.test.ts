// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import {
  getAutomationDetailNextTab,
  shouldHandleAutomationDetailEscapeKey,
  shouldHandleAutomationDetailTabArrowKey
} from './automation-detail-tab-navigation'

describe('shouldHandleAutomationDetailTabArrowKey', () => {
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
      key: 'ArrowRight',
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      nativeEvent: { isComposing: overrides.isComposing ?? false },
      target: overrides.target ?? document.body,
      ...overrides
    }
  }

  it('ignores modified or composing arrow keys', () => {
    expect(shouldHandleAutomationDetailTabArrowKey(makeEvent({ metaKey: true }))).toBe(false)
    expect(shouldHandleAutomationDetailTabArrowKey(makeEvent({ ctrlKey: true }))).toBe(false)
    expect(shouldHandleAutomationDetailTabArrowKey(makeEvent({ altKey: true }))).toBe(false)
    expect(shouldHandleAutomationDetailTabArrowKey(makeEvent({ shiftKey: true }))).toBe(false)
    expect(shouldHandleAutomationDetailTabArrowKey(makeEvent({ isComposing: true }))).toBe(false)
  })

  it('ignores keys when focus is inside text input, textarea, or contentEditable', () => {
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    const select = document.createElement('select')
    const editable = document.createElement('div')
    editable.contentEditable = 'true'

    expect(shouldHandleAutomationDetailTabArrowKey(makeEvent({ target: input }))).toBe(false)
    expect(shouldHandleAutomationDetailTabArrowKey(makeEvent({ target: textarea }))).toBe(false)
    expect(shouldHandleAutomationDetailTabArrowKey(makeEvent({ target: select }))).toBe(false)
    expect(shouldHandleAutomationDetailTabArrowKey(makeEvent({ target: editable }))).toBe(false)
  })

  it.each(['dialog', 'menu', 'listbox'])('ignores keys inside a %s', (role) => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', role)
    const childButton = document.createElement('button')
    dialog.appendChild(childButton)
    document.body.appendChild(dialog)

    expect(shouldHandleAutomationDetailTabArrowKey(makeEvent({ target: childButton }))).toBe(false)

    dialog.remove()
  })
})

describe('getAutomationDetailNextTab', () => {
  it('prevents switching to runs if canAccessRuns is false', () => {
    expect(
      getAutomationDetailNextTab({
        currentTab: 'overview',
        key: 'ArrowRight',
        canAccessRuns: false
      })
    ).toBeNull()
  })
})

describe('shouldHandleAutomationDetailEscapeKey', () => {
  function makeEvent(
    overrides: Partial<{
      key: string
      defaultPrevented: boolean
      altKey: boolean
      ctrlKey: boolean
      metaKey: boolean
      shiftKey: boolean
      isComposing: boolean
      target: EventTarget | null
    }> = {}
  ) {
    return {
      key: 'Escape',
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      nativeEvent: { isComposing: overrides.isComposing ?? false },
      target: overrides.target ?? document.body,
      ...overrides
    }
  }

  it('ignores Escape already consumed while returning from a run', () => {
    expect(shouldHandleAutomationDetailEscapeKey(makeEvent({ defaultPrevented: true }))).toBe(false)
  })

  it('ignores modified or composing Escape keys', () => {
    expect(shouldHandleAutomationDetailEscapeKey(makeEvent({ metaKey: true }))).toBe(false)
    expect(shouldHandleAutomationDetailEscapeKey(makeEvent({ ctrlKey: true }))).toBe(false)
    expect(shouldHandleAutomationDetailEscapeKey(makeEvent({ altKey: true }))).toBe(false)
    expect(shouldHandleAutomationDetailEscapeKey(makeEvent({ shiftKey: true }))).toBe(false)
    expect(shouldHandleAutomationDetailEscapeKey(makeEvent({ isComposing: true }))).toBe(false)
  })

  it('ignores Escape when focus is inside text input, textarea, contentEditable, or escapeClearsValue', () => {
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    const select = document.createElement('select')
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    const clearsValue = document.createElement('div')
    clearsValue.setAttribute('data-escape-clears-value', 'true')

    expect(shouldHandleAutomationDetailEscapeKey(makeEvent({ target: input }))).toBe(false)
    expect(shouldHandleAutomationDetailEscapeKey(makeEvent({ target: textarea }))).toBe(false)
    expect(shouldHandleAutomationDetailEscapeKey(makeEvent({ target: select }))).toBe(false)
    expect(shouldHandleAutomationDetailEscapeKey(makeEvent({ target: editable }))).toBe(false)
    expect(shouldHandleAutomationDetailEscapeKey(makeEvent({ target: clearsValue }))).toBe(false)
  })

  it.each(['dialog', 'menu', 'listbox'])('ignores Escape inside a %s', (role) => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', role)
    const childButton = document.createElement('button')
    dialog.appendChild(childButton)
    document.body.appendChild(dialog)

    expect(shouldHandleAutomationDetailEscapeKey(makeEvent({ target: childButton }))).toBe(false)

    dialog.remove()
  })
})
