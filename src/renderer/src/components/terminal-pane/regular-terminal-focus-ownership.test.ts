// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REGULAR_TERMINAL_INPUT_FOCUSED_ATTRIBUTE,
  getPaneOwnedActiveHelperTextarea,
  releaseTerminalFocusForOutsidePointerDown,
  releaseTerminalFocusForWindowBlur,
  resyncTerminalFocusForWindowFocus,
  setRegularTerminalInputFocusAttribute
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

  it('releases and blurs the owning helper textarea on outside pointerdown', () => {
    const pane = appendPane()
    const helper = appendHelper(pane)
    const outside = document.createElement('button')
    const syncFocused = vi.fn()
    const blur = vi.spyOn(helper, 'blur')
    document.body.appendChild(outside)
    helper.focus()

    const released = releaseTerminalFocusForOutsidePointerDown({
      container: pane,
      activeElement: document.activeElement,
      pointerTarget: outside,
      syncFocused
    })

    expect(released).toBe(true)
    expect(syncFocused).toHaveBeenCalledWith(false)
    expect(blur).toHaveBeenCalledOnce()
  })

  it('keeps ownership for pointerdowns inside the same terminal pane', () => {
    const pane = appendPane()
    const helper = appendHelper(pane)
    const innerTarget = document.createElement('div')
    const syncFocused = vi.fn()
    const blur = vi.spyOn(helper, 'blur')
    pane.appendChild(innerTarget)
    helper.focus()

    const released = releaseTerminalFocusForOutsidePointerDown({
      container: pane,
      activeElement: document.activeElement,
      pointerTarget: innerTarget,
      syncFocused
    })

    expect(released).toBe(false)
    expect(syncFocused).not.toHaveBeenCalled()
    expect(blur).not.toHaveBeenCalled()
  })

  it("does not clear another pane's active helper ownership", () => {
    const pane = appendPane()
    const otherPane = appendPane()
    const otherHelper = appendHelper(otherPane)
    const outside = document.createElement('button')
    const syncFocused = vi.fn()
    document.body.appendChild(outside)
    otherHelper.focus()

    const released = releaseTerminalFocusForOutsidePointerDown({
      container: pane,
      activeElement: document.activeElement,
      pointerTarget: outside,
      syncFocused
    })

    expect(released).toBe(false)
    expect(syncFocused).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(otherHelper)
  })

  it('releases the main-process mirror on renderer blur without blurring DOM focus', () => {
    const pane = appendPane()
    const helper = appendHelper(pane)
    const syncFocused = vi.fn()
    const blur = vi.spyOn(helper, 'blur')
    helper.focus()

    const released = releaseTerminalFocusForWindowBlur({
      container: pane,
      activeElement: document.activeElement,
      syncFocused
    })

    expect(released).toBe(true)
    expect(syncFocused).toHaveBeenCalledWith(false)
    expect(blur).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(helper)
  })

  it('resyncs terminal ownership on renderer focus when the same helper remains active', () => {
    const pane = appendPane()
    const helper = appendHelper(pane)
    const syncFocused = vi.fn()
    helper.focus()

    const synced = resyncTerminalFocusForWindowFocus({
      container: pane,
      activeElement: document.activeElement,
      syncFocused,
      isMac: false
    })

    expect(synced).toBe(true)
    expect(syncFocused).toHaveBeenCalledWith(true)
  })

  it('rebuilds the IME context on macOS focus via blur then next-frame refocus', () => {
    const pane = appendPane()
    const helper = appendHelper(pane)
    const syncFocused = vi.fn()
    const blur = vi.spyOn(helper, 'blur')
    const focus = vi.spyOn(helper, 'focus')
    helper.focus()
    focus.mockClear()
    const scheduled: (() => void)[] = []

    const synced = resyncTerminalFocusForWindowFocus({
      container: pane,
      activeElement: document.activeElement,
      syncFocused,
      isMac: true,
      scheduleRefocus: (callback) => scheduled.push(callback)
    })

    expect(synced).toBe(true)
    expect(syncFocused).toHaveBeenCalledWith(true)
    expect(blur).toHaveBeenCalledOnce()
    expect(focus).not.toHaveBeenCalled()

    for (const run of scheduled) {
      run()
    }
    expect(focus).toHaveBeenCalledOnce()
  })

  it('does not steal focus back if another element grabbed it during the frame', () => {
    const pane = appendPane()
    const helper = appendHelper(pane)
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    const syncFocused = vi.fn()
    const focus = vi.spyOn(helper, 'focus')
    helper.focus()
    focus.mockClear()
    const scheduled: (() => void)[] = []

    resyncTerminalFocusForWindowFocus({
      container: pane,
      activeElement: document.activeElement,
      syncFocused,
      isMac: true,
      scheduleRefocus: (callback) => scheduled.push(callback)
    })

    outside.focus()
    for (const run of scheduled) {
      run()
    }
    expect(focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(outside)
  })

  it('skips the blur/refocus cycle on non-macOS platforms', () => {
    const pane = appendPane()
    const helper = appendHelper(pane)
    const syncFocused = vi.fn()
    const blur = vi.spyOn(helper, 'blur')
    helper.focus()

    resyncTerminalFocusForWindowFocus({
      container: pane,
      activeElement: document.activeElement,
      syncFocused,
      isMac: false,
      scheduleRefocus: () => {
        throw new Error('should not schedule refocus on non-macOS')
      }
    })

    expect(blur).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(helper)
  })

  it('resolves an owned active xterm helper textarea', () => {
    const pane = appendPane()
    const helper = appendHelper(pane)
    const otherPane = appendPane()
    const button = document.createElement('button')
    document.body.appendChild(button)

    expect(getPaneOwnedActiveHelperTextarea(pane, helper)).toBe(helper)
    expect(getPaneOwnedActiveHelperTextarea(pane, button)).toBeNull()
    expect(getPaneOwnedActiveHelperTextarea(otherPane, helper)).toBeNull()
    expect(getPaneOwnedActiveHelperTextarea(pane, null)).toBeNull()
  })

  it('tracks regular terminal focus on the document element for titlebar click release', () => {
    setRegularTerminalInputFocusAttribute(true)
    expect(document.documentElement.hasAttribute(REGULAR_TERMINAL_INPUT_FOCUSED_ATTRIBUTE)).toBe(
      true
    )

    setRegularTerminalInputFocusAttribute(false)
    expect(document.documentElement.hasAttribute(REGULAR_TERMINAL_INPUT_FOCUSED_ATTRIBUTE)).toBe(
      false
    )
  })
})
