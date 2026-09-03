// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { makeRun } from './automations-page-fixtures'
import {
  getAutomationRunHistoryArrowTarget,
  isAutomationRunHistoryArrowKey,
  shouldHandleAutomationRunHistoryKey
} from './automation-run-history-keyboard-navigation'

describe('isAutomationRunHistoryArrowKey', () => {
  it('identifies ArrowUp and ArrowDown', () => {
    expect(isAutomationRunHistoryArrowKey('ArrowUp')).toBe(true)
    expect(isAutomationRunHistoryArrowKey('ArrowDown')).toBe(true)
    expect(isAutomationRunHistoryArrowKey('ArrowLeft')).toBe(false)
    expect(isAutomationRunHistoryArrowKey('ArrowRight')).toBe(false)
    expect(isAutomationRunHistoryArrowKey('Enter')).toBe(false)
  })
})

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

  it('allows unmodified ArrowUp, ArrowDown, and Enter', () => {
    expect(shouldHandleAutomationRunHistoryKey(makeEvent({ key: 'ArrowDown' }))).toBe(true)
    expect(shouldHandleAutomationRunHistoryKey(makeEvent({ key: 'ArrowUp' }))).toBe(true)
    expect(shouldHandleAutomationRunHistoryKey(makeEvent({ key: 'Enter' }))).toBe(true)
  })

  it('ignores other keys', () => {
    expect(shouldHandleAutomationRunHistoryKey(makeEvent({ key: 'ArrowLeft' }))).toBe(false)
    expect(shouldHandleAutomationRunHistoryKey(makeEvent({ key: 'ArrowRight' }))).toBe(false)
    expect(shouldHandleAutomationRunHistoryKey(makeEvent({ key: 'Space' }))).toBe(false)
  })

  it('ignores modified or composing keys', () => {
    expect(shouldHandleAutomationRunHistoryKey(makeEvent({ metaKey: true }))).toBe(false)
    expect(shouldHandleAutomationRunHistoryKey(makeEvent({ ctrlKey: true }))).toBe(false)
    expect(shouldHandleAutomationRunHistoryKey(makeEvent({ altKey: true }))).toBe(false)
    expect(shouldHandleAutomationRunHistoryKey(makeEvent({ shiftKey: true }))).toBe(false)
    expect(shouldHandleAutomationRunHistoryKey(makeEvent({ isComposing: true }))).toBe(false)
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

describe('getAutomationRunHistoryArrowTarget', () => {
  const run1 = makeRun({ id: 'run-1' })
  const run2 = makeRun({ id: 'run-2' })
  const run3 = makeRun({ id: 'run-3' })
  const runs = [run1, run2, run3]

  it('returns null for empty runs list', () => {
    expect(
      getAutomationRunHistoryArrowTarget({
        runs: [],
        selectedRunId: null,
        key: 'ArrowDown'
      })
    ).toBeNull()
  })

  it('moves selection down from first item to second item', () => {
    expect(
      getAutomationRunHistoryArrowTarget({
        runs,
        selectedRunId: 'run-1',
        key: 'ArrowDown'
      })
    ).toBe(run2)
  })

  it('moves selection up from second item to first item', () => {
    expect(
      getAutomationRunHistoryArrowTarget({
        runs,
        selectedRunId: 'run-2',
        key: 'ArrowUp'
      })
    ).toBe(run1)
  })

  it('clamps at the bottom of the runs list', () => {
    expect(
      getAutomationRunHistoryArrowTarget({
        runs,
        selectedRunId: 'run-3',
        key: 'ArrowDown'
      })
    ).toBe(run3)
  })

  it('clamps at the top of the runs list', () => {
    expect(
      getAutomationRunHistoryArrowTarget({
        runs,
        selectedRunId: 'run-1',
        key: 'ArrowUp'
      })
    ).toBe(run1)
  })

  it('defaults to index 0 on ArrowDown when nothing was selected', () => {
    expect(
      getAutomationRunHistoryArrowTarget({
        runs,
        selectedRunId: null,
        key: 'ArrowDown'
      })
    ).toBe(run2)
  })
})
