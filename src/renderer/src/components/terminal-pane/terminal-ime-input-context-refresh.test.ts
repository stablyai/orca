// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isTerminalFocusUnclaimed,
  isTerminalImeInputContextRefreshing,
  refreshTerminalImeInputContext,
  terminalHelperAwaitingImeRefocus
} from './terminal-ime-input-context-refresh'

describe('refreshTerminalImeInputContext', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  function appendHelper(): HTMLTextAreaElement {
    const helper = document.createElement('textarea')
    helper.className = 'xterm-helper-textarea'
    document.body.appendChild(helper)
    return helper
  }

  it('blurs then refocuses the helper on macOS', () => {
    const helper = appendHelper()
    const blur = vi.spyOn(helper, 'blur')
    const focus = vi.spyOn(helper, 'focus')
    helper.focus()
    focus.mockClear()
    const scheduled: (() => void)[] = []

    const refreshed = refreshTerminalImeInputContext(helper, {
      isMac: true,
      scheduleRefocus: (callback) => scheduled.push(callback)
    })

    expect(refreshed).toBe(true)
    expect(blur).toHaveBeenCalledOnce()
    expect(focus).not.toHaveBeenCalled()

    for (const run of scheduled) {
      run()
    }
    expect(focus).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(helper)
  })

  it('reports the helper as awaiting refocus until its frame runs', () => {
    const helper = appendHelper()
    helper.focus()
    const scheduled: (() => void)[] = []
    expect(terminalHelperAwaitingImeRefocus()).toBeNull()
    expect(isTerminalFocusUnclaimed(document.activeElement, document)).toBe(false)

    refreshTerminalImeInputContext(helper, {
      isMac: true,
      scheduleRefocus: (callback) => scheduled.push(callback)
    })

    expect(document.activeElement).toBe(document.body)
    expect(terminalHelperAwaitingImeRefocus()).toBe(helper)
    expect(isTerminalFocusUnclaimed(document.activeElement, document)).toBe(false)
    expect(isTerminalFocusUnclaimed(document.activeElement, document, helper)).toBe(true)

    for (const run of scheduled) {
      run()
    }
    expect(terminalHelperAwaitingImeRefocus()).toBeNull()
    helper.blur()
    expect(isTerminalFocusUnclaimed(document.activeElement, document)).toBe(true)
  })

  it('keeps the newer refresh pending when an older refresh of the same helper fires first', () => {
    const helper = appendHelper()
    helper.focus()
    const scheduled: (() => void)[] = []
    const schedule = (callback: () => void): number => scheduled.push(callback)
    const staleSkipped = vi.fn()
    const skipped = vi.fn()

    refreshTerminalImeInputContext(helper, {
      isMac: true,
      scheduleRefocus: schedule,
      onRefocusSkipped: staleSkipped
    })
    helper.focus()
    refreshTerminalImeInputContext(helper, {
      isMac: true,
      scheduleRefocus: schedule,
      onRefocusSkipped: skipped
    })
    expect(scheduled).toHaveLength(2)

    scheduled[0]?.()
    expect(terminalHelperAwaitingImeRefocus()).toBe(helper)
    expect(isTerminalFocusUnclaimed(document.activeElement, document)).toBe(false)
    // Why: the stale callback saw the newer refresh's body gap, not a lost focus.
    expect(staleSkipped).not.toHaveBeenCalled()

    scheduled[1]?.()
    expect(terminalHelperAwaitingImeRefocus()).toBeNull()
    expect(document.activeElement).toBe(helper)
    expect(skipped).not.toHaveBeenCalled()
  })

  it('lets the newest refresh win when two helpers refresh back to back', () => {
    const first = appendHelper()
    const second = appendHelper()
    const scheduled: (() => void)[] = []
    const schedule = (callback: () => void): number => scheduled.push(callback)
    const firstSkipped = vi.fn()
    first.focus()
    refreshTerminalImeInputContext(first, {
      isMac: true,
      scheduleRefocus: schedule,
      onRefocusSkipped: firstSkipped
    })
    second.focus()
    refreshTerminalImeInputContext(second, { isMac: true, scheduleRefocus: schedule })
    expect(terminalHelperAwaitingImeRefocus()).toBe(second)

    for (const run of scheduled) {
      run()
    }

    expect(document.activeElement).toBe(second)
    // Why: the first helper's owner must learn that the second one took over, even though the
    // document still reported body when the stale callback ran.
    expect(firstSkipped).toHaveBeenCalledOnce()
    expect(firstSkipped).toHaveBeenCalledWith(second)
    expect(terminalHelperAwaitingImeRefocus()).toBeNull()
  })

  it('still reports a stale refresh when a different control took focus for real', () => {
    const helper = appendHelper()
    const input = document.createElement('input')
    document.body.appendChild(input)
    const scheduled: (() => void)[] = []
    const schedule = (callback: () => void): number => scheduled.push(callback)
    const staleSkipped = vi.fn()
    helper.focus()
    refreshTerminalImeInputContext(helper, {
      isMac: true,
      scheduleRefocus: schedule,
      onRefocusSkipped: staleSkipped
    })
    helper.focus()
    refreshTerminalImeInputContext(helper, { isMac: true, scheduleRefocus: schedule })
    input.focus()

    scheduled[0]?.()

    expect(staleSkipped).toHaveBeenCalledWith(input)
  })

  it('marks only the synchronous refresh blur so focus ownership can stay latched', () => {
    const helper = appendHelper()
    let refreshingDuringBlur = false
    helper.addEventListener('blur', (event) => {
      refreshingDuringBlur = isTerminalImeInputContextRefreshing(event.target)
    })
    helper.focus()

    refreshTerminalImeInputContext(helper, {
      isMac: true,
      scheduleRefocus: vi.fn()
    })

    expect(refreshingDuringBlur).toBe(true)
    expect(isTerminalImeInputContextRefreshing(helper)).toBe(false)
  })

  it('does not steal focus if another element grabbed it before the refocus frame', () => {
    const helper = appendHelper()
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    const focus = vi.spyOn(helper, 'focus')
    helper.focus()
    focus.mockClear()
    const scheduled: (() => void)[] = []

    refreshTerminalImeInputContext(helper, {
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

  it('reports when a newer focus owner wins the refocus guard', () => {
    const helper = appendHelper()
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    const onRefocusSkipped = vi.fn()
    const scheduled: (() => void)[] = []
    helper.focus()

    refreshTerminalImeInputContext(helper, {
      isMac: true,
      onRefocusSkipped,
      scheduleRefocus: (callback) => scheduled.push(callback)
    })

    outside.focus()
    for (const run of scheduled) {
      run()
    }
    expect(onRefocusSkipped).toHaveBeenCalledWith(outside)
  })

  it('reports when a connected helper cannot accept the scheduled focus', () => {
    const helper = appendHelper()
    const onRefocusSkipped = vi.fn()
    const scheduled: (() => void)[] = []
    helper.focus()

    refreshTerminalImeInputContext(helper, {
      isMac: true,
      onRefocusSkipped,
      scheduleRefocus: (callback) => scheduled.push(callback)
    })
    vi.spyOn(helper, 'focus').mockImplementation(() => undefined)
    for (const run of scheduled) {
      run()
    }

    expect(document.activeElement).toBe(document.body)
    expect(onRefocusSkipped).toHaveBeenCalledWith(document.body)
  })

  it('skips non-macOS platforms', () => {
    const helper = appendHelper()
    const blur = vi.spyOn(helper, 'blur')

    const refreshed = refreshTerminalImeInputContext(helper, {
      isMac: false,
      scheduleRefocus: () => {
        throw new Error('should not schedule')
      }
    })

    expect(refreshed).toBe(false)
    expect(blur).not.toHaveBeenCalled()
  })
})
