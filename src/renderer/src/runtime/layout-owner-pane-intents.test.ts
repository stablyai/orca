import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetLayoutOwnerPaneIntentsForTests,
  expectPaneToClose,
  holdTabPaneTree,
  isTabPaneTreeHeld,
  onTabPaneTreeRedraw,
  requestTabPaneTreeRedraw,
  takePaneCloseIntent
} from './layout-owner-pane-intents'

describe('layout-owner pane intents', () => {
  beforeEach(() => _resetLayoutOwnerPaneIntentsForTests())

  it('hands an intent out once, and only for its own tab', () => {
    expectPaneToClose('tab-1', 'leaf-old', 'user')

    expect(takePaneCloseIntent('tab-2', 'leaf-old')).toBeNull()
    expect(takePaneCloseIntent('tab-1', 'leaf-old')).toBe('user')
    expect(takePaneCloseIntent('tab-1', 'leaf-old')).toBeNull()
  })

  it('forgets only its own intent, not a newer one for the same pane', () => {
    const forgetFirst = expectPaneToClose('tab-1', 'leaf-1', 'user')
    expectPaneToClose('tab-1', 'leaf-1', 'exit')

    forgetFirst()

    expect(takePaneCloseIntent('tab-1', 'leaf-1')).toBe('exit')
  })

  it('keeps only the newest intents', () => {
    for (let index = 0; index < 65; index += 1) {
      expectPaneToClose('tab-1', `leaf-${index}`, 'exit')
    }

    expect(takePaneCloseIntent('tab-1', 'leaf-0')).toBeNull()
    expect(takePaneCloseIntent('tab-1', 'leaf-64')).toBe('exit')
  })

  it('holds a tab until its last hold is released, then tells the listener once', () => {
    const listener = vi.fn()
    onTabPaneTreeRedraw(listener)
    const first = holdTabPaneTree('tab-1')
    const second = holdTabPaneTree('tab-1')

    first()
    first()
    expect(isTabPaneTreeHeld('tab-1')).toBe(true)
    expect(listener).not.toHaveBeenCalled()

    second()
    expect(isTabPaneTreeHeld('tab-1')).toBe(false)
    expect(listener).toHaveBeenCalledExactlyOnceWith('tab-1')

    requestTabPaneTreeRedraw('tab-2')
    expect(listener).toHaveBeenLastCalledWith('tab-2')
  })
})
