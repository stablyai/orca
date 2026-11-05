// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  onActiveTerminalPaneCloseRequest,
  requestActiveTerminalPaneClose
} from './request-active-terminal-pane-close'

describe('active terminal pane close request', () => {
  const unsubscribes: (() => void)[] = []
  afterEach(() => {
    unsubscribes.splice(0).forEach((unsubscribe) => unsubscribe())
  })

  it('reaches only the pane mounted for the named tab', () => {
    const closeA = vi.fn()
    const closeB = vi.fn()
    unsubscribes.push(onActiveTerminalPaneCloseRequest('tab-a', closeA))
    unsubscribes.push(onActiveTerminalPaneCloseRequest('tab-b', closeB))

    requestActiveTerminalPaneClose('tab-a')

    expect(closeA).toHaveBeenCalledOnce()
    expect(closeB).not.toHaveBeenCalled()
  })

  it('stops reaching a pane once it unsubscribes', () => {
    const close = vi.fn()
    onActiveTerminalPaneCloseRequest('tab-a', close)()

    requestActiveTerminalPaneClose('tab-a')

    expect(close).not.toHaveBeenCalled()
  })

  it('targets the selected leaf instead of the active sibling', () => {
    const close = vi.fn()
    unsubscribes.push(onActiveTerminalPaneCloseRequest('tab-a', close))
    expect(requestActiveTerminalPaneClose('tab-a', 'leaf-b')).toBe(true)
    expect(close).toHaveBeenCalledWith('leaf-b')
    expect(requestActiveTerminalPaneClose('unmounted-tab', 'leaf-b')).toBe(false)
  })
})
