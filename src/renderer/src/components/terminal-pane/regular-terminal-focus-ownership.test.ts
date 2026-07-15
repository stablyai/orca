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

    expect(released).toBe(helper)
    expect(syncFocused).toHaveBeenCalledWith(false)
    expect(blur).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(helper)
  })

  it('returns null on renderer blur when this pane did not own the active helper', () => {
    const pane = appendPane()
    appendHelper(pane)
    const syncFocused = vi.fn()
    document.body.focus()

    const released = releaseTerminalFocusForWindowBlur({
      container: pane,
      activeElement: document.activeElement,
      syncFocused
    })

    expect(released).toBeNull()
    expect(syncFocused).not.toHaveBeenCalled()
  })

  it('reclaims and refocuses the released helper (next frame) when blur dropped focus to body', () => {
    const pane = appendPane()
    const helper = appendHelper(pane)
    const syncFocused = vi.fn()
    const focus = vi.spyOn(helper, 'focus')
    helper.focus()

    const releasedHelper = releaseTerminalFocusForWindowBlur({
      container: pane,
      activeElement: helper,
      syncFocused
    })
    expect(releasedHelper).toBe(helper)
    syncFocused.mockClear()
    document.body.focus()
    focus.mockClear()
    const scheduled: (() => void)[] = []

    const synced = resyncTerminalFocusForWindowFocus({
      container: pane,
      activeElement: document.activeElement,
      syncFocused,
      releasedHelper,
      isMac: false,
      scheduleRefocus: (callback) => scheduled.push(callback)
    })

    expect(synced).toBe(true)
    expect(syncFocused).toHaveBeenCalledWith(true)
    // Why: reclaim is deferred so a newer focus owner during reactivation wins.
    expect(focus).not.toHaveBeenCalled()
    for (const run of scheduled) {
      run()
    }
    expect(focus).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(helper)
  })

  it('reclaims the exact split helper that was released, not the first one in the container', () => {
    // Why: a single TerminalPane hosts every split as siblings under one
    // container, so a first-match querySelector would refocus the wrong split.
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
    // Why: the Linux reclaim path must honor the same "newer focus owner wins"
    // guard the macOS path uses, so a click into the sidebar/dialog isn't stolen.
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
    expect(document.activeElement).toBe(outside)
  })

  it('rolls the focus mirror back to false when a newer owner wins the deferred reclaim', () => {
    // Why: the eager syncFocused(true) on reactivation assumes the terminal
    // will reclaim focus next frame. When a dialog/sidebar/rename input grabs
    // focus first, the reclaim is skipped, so the main-process mirror must roll
    // back to false or shortcuts stay stuck in 'terminal' context.
    const pane = appendPane()
    const helper = appendHelper(pane)
    const outside = document.createElement('input')
    document.body.appendChild(outside)
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
    expect(syncFocused).toHaveBeenCalledWith(true)
    // A newer focus owner (dialog/sidebar) grabs focus before the deferred reclaim.
    outside.focus()
    for (const run of scheduled) {
      run()
    }

    expect(syncFocused).toHaveBeenLastCalledWith(false)
    expect(document.activeElement).toBe(outside)
  })

  it('does not reclaim a released helper that was detached from the DOM before refocus', () => {
    const pane = appendPane()
    const helper = appendHelper(pane)
    const syncFocused = vi.fn()
    helper.focus()

    const releasedHelper = releaseTerminalFocusForWindowBlur({
      container: pane,
      activeElement: helper,
      syncFocused
    })
    // The split that owned focus was closed during the blur.
    helper.remove()
    document.body.focus()

    const synced = resyncTerminalFocusForWindowFocus({
      container: pane,
      activeElement: document.activeElement,
      syncFocused,
      releasedHelper,
      isMac: false
    })

    expect(synced).toBe(false)
  })

  it('does not reclaim focus on window focus without a prior blur release', () => {
    const pane = appendPane()
    appendHelper(pane)
    const syncFocused = vi.fn()
    document.body.focus()

    const synced = resyncTerminalFocusForWindowFocus({
      container: pane,
      activeElement: document.activeElement,
      syncFocused,
      releasedHelper: null,
      isMac: false
    })

    expect(synced).toBe(false)
    expect(syncFocused).not.toHaveBeenCalled()
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
