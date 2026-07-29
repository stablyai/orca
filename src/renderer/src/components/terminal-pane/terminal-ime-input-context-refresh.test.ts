// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isTerminalImeInputContextRefreshing,
  refreshTerminalImeInputContext
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
