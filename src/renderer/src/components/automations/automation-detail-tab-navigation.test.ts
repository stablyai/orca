// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import {
  getAutomationDetailNextTab,
  isAutomationDetailTabArrowKey,
  shouldHandleAutomationDetailEscapeKey,
  shouldHandleAutomationDetailTabArrowKey
} from './automation-detail-tab-navigation'

describe('isAutomationDetailTabArrowKey', () => {
  it('identifies ArrowLeft and ArrowRight', () => {
    expect(isAutomationDetailTabArrowKey('ArrowLeft')).toBe(true)
    expect(isAutomationDetailTabArrowKey('ArrowRight')).toBe(true)
    expect(isAutomationDetailTabArrowKey('ArrowUp')).toBe(false)
    expect(isAutomationDetailTabArrowKey('ArrowDown')).toBe(false)
    expect(isAutomationDetailTabArrowKey('Enter')).toBe(false)
  })
})

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

  it('allows unmodified ArrowLeft and ArrowRight on neutral targets', () => {
    expect(shouldHandleAutomationDetailTabArrowKey(makeEvent({ key: 'ArrowRight' }))).toBe(true)
    expect(shouldHandleAutomationDetailTabArrowKey(makeEvent({ key: 'ArrowLeft' }))).toBe(true)
  })

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

  it('ignores keys when target is inside a modal dialog, menu, or listbox', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const childButton = document.createElement('button')
    dialog.appendChild(childButton)
    document.body.appendChild(dialog)

    expect(shouldHandleAutomationDetailTabArrowKey(makeEvent({ target: childButton }))).toBe(false)

    dialog.remove()
  })
})

describe('getAutomationDetailNextTab', () => {
  it('switches from overview to runs on ArrowRight', () => {
    expect(
      getAutomationDetailNextTab({
        currentTab: 'overview',
        key: 'ArrowRight',
        canAccessRuns: true
      })
    ).toBe('runs')
  })

  it('does nothing when on overview and pressing ArrowLeft', () => {
    expect(
      getAutomationDetailNextTab({
        currentTab: 'overview',
        key: 'ArrowLeft'
      })
    ).toBeNull()
  })

  it('switches from runs to overview on ArrowLeft', () => {
    expect(
      getAutomationDetailNextTab({
        currentTab: 'runs',
        key: 'ArrowLeft'
      })
    ).toBe('overview')
  })

  it('does nothing when on runs and pressing ArrowRight', () => {
    expect(
      getAutomationDetailNextTab({
        currentTab: 'runs',
        key: 'ArrowRight'
      })
    ).toBeNull()
  })

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

  it('allows unmodified Escape on neutral targets', () => {
    expect(shouldHandleAutomationDetailEscapeKey(makeEvent())).toBe(true)
  })

  it('allows Escape on SVGElement and document targets', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    expect(shouldHandleAutomationDetailEscapeKey(makeEvent({ target: svg }))).toBe(true)
    expect(shouldHandleAutomationDetailEscapeKey(makeEvent({ target: document }))).toBe(true)
  })

  it('ignores non-Escape keys', () => {
    expect(shouldHandleAutomationDetailEscapeKey(makeEvent({ key: 'Enter' }))).toBe(false)
    expect(shouldHandleAutomationDetailEscapeKey(makeEvent({ key: 'ArrowLeft' }))).toBe(false)
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

  it('ignores Escape when target is inside a modal dialog, menu, or listbox', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const childButton = document.createElement('button')
    dialog.appendChild(childButton)
    document.body.appendChild(dialog)

    expect(shouldHandleAutomationDetailEscapeKey(makeEvent({ target: childButton }))).toBe(false)

    dialog.remove()
  })
})
