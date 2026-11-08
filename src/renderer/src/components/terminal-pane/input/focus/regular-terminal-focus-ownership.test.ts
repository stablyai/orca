// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REGULAR_TERMINAL_INPUT_FOCUSED_ATTRIBUTE,
  releaseTerminalFocusForWindowBlur,
  resyncTerminalFocusForWindowFocus
} from './regular-terminal-focus-ownership'

function appendPane(): HTMLDivElement {
  const pane = document.createElement('div')
  document.body.appendChild(pane)
  return pane
}

function appendHelper(pane: HTMLElement): HTMLTextAreaElement {
  const helper = document.createElement('textarea')
  helper.className = 'xterm-helper-textarea'
  pane.appendChild(helper)
  return helper
}

describe('regular terminal focus ownership', () => {
  beforeEach(() => {
    document.body.replaceChildren()
    document.documentElement.removeAttribute(REGULAR_TERMINAL_INPUT_FOCUSED_ATTRIBUTE)
  })

  it('reclaims the exact split helper that was released, not the first one in the container', () => {
    // Split helpers are siblings in one container; first-match lookup would reclaim the wrong pane.
    const pane = appendPane()
    const firstHelper = appendHelper(pane)
    const secondHelper = appendHelper(pane)
    const syncFocused = vi.fn()
    const firstFocus = vi.spyOn(firstHelper, 'focus')
    const secondFocus = vi.spyOn(secondHelper, 'focus')
    secondHelper.focus()

    const releasedHelper = releaseTerminalFocusForWindowBlur({
      container: pane,
      activeElement: secondHelper,
      syncFocused
    })
    expect(releasedHelper).toBe(secondHelper)
    document.body.focus()
    firstFocus.mockClear()
    secondFocus.mockClear()
    const scheduled: (() => void)[] = []

    resyncTerminalFocusForWindowFocus({
      container: pane,
      activeElement: document.activeElement,
      syncFocused,
      releasedHelper,
      isMac: false,
      scheduleRefocus: (callback) => scheduled.push(callback)
    })
    for (const run of scheduled) {
      run()
    }

    expect(secondFocus).toHaveBeenCalledOnce()
    expect(firstFocus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(secondHelper)
  })

  it('does not yank focus back into the terminal if the user clicked elsewhere during reactivation', () => {
    // Linux must honor the same newer-focus-owner guard as macOS during deferred reclaim.
    const pane = appendPane()
    const helper = appendHelper(pane)
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    const syncFocused = vi.fn()
    const focus = vi.spyOn(helper, 'focus')
    helper.focus()

    const releasedHelper = releaseTerminalFocusForWindowBlur({
      container: pane,
      activeElement: helper,
      syncFocused
    })
    document.body.focus()
    syncFocused.mockClear()
    focus.mockClear()
    const scheduled: (() => void)[] = []

    resyncTerminalFocusForWindowFocus({
      container: pane,
      activeElement: document.activeElement,
      syncFocused,
      releasedHelper,
      isMac: false,
      scheduleRefocus: (callback) => scheduled.push(callback)
    })
    // User clicks into another field before the deferred reclaim runs.
    outside.focus()
    for (const run of scheduled) {
      run()
    }

    expect(focus).not.toHaveBeenCalled()
    expect(syncFocused).toHaveBeenCalledWith(false)
    expect(document.activeElement).toBe(outside)
  })

  it('does not clear ownership published by a newer terminal during deferred reclaim', () => {
    const pane = appendPane()
    const helper = appendHelper(pane)
    const newerPane = appendPane()
    const newerHelper = appendHelper(newerPane)
    const syncFocused = vi.fn()
    helper.focus()

    const releasedHelper = releaseTerminalFocusForWindowBlur({
      container: pane,
      activeElement: helper,
      syncFocused
    })
    document.body.focus()
    syncFocused.mockClear()
    const scheduled: (() => void)[] = []

    resyncTerminalFocusForWindowFocus({
      container: pane,
      activeElement: document.activeElement,
      syncFocused,
      releasedHelper,
      isMac: false,
      scheduleRefocus: (callback) => scheduled.push(callback)
    })
    newerHelper.focus()
    for (const run of scheduled) {
      run()
    }

    expect(document.activeElement).toBe(newerHelper)
    expect(syncFocused).not.toHaveBeenCalled()
  })

  it('does not clear ownership published by a newer terminal during IME refresh', () => {
    const pane = appendPane()
    const helper = appendHelper(pane)
    const newerHelper = appendHelper(appendPane())
    const syncFocused = vi.fn()
    helper.focus()
    const scheduled: (() => void)[] = []

    resyncTerminalFocusForWindowFocus({
      container: pane,
      activeElement: document.activeElement,
      syncFocused,
      isMac: true,
      scheduleRefocus: (callback) => scheduled.push(callback)
    })
    syncFocused.mockClear()
    newerHelper.focus()
    for (const run of scheduled) {
      run()
    }

    expect(document.activeElement).toBe(newerHelper)
    expect(syncFocused).not.toHaveBeenCalled()
  })
})
