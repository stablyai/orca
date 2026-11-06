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
})
