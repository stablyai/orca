// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { useTerminalPaneCloseRequest } from './use-terminal-pane-close-request'
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
    const closeA = vi.fn(() => true)
    const closeB = vi.fn(() => true)
    unsubscribes.push(onActiveTerminalPaneCloseRequest('tab-a', closeA))
    unsubscribes.push(onActiveTerminalPaneCloseRequest('tab-b', closeB))

    requestActiveTerminalPaneClose('tab-a')

    expect(closeA).toHaveBeenCalledOnce()
    expect(closeB).not.toHaveBeenCalled()
  })

  it('stops reaching a pane once it unsubscribes', () => {
    const close = vi.fn(() => true)
    onActiveTerminalPaneCloseRequest('tab-a', close)()

    requestActiveTerminalPaneClose('tab-a')

    expect(close).not.toHaveBeenCalled()
  })

  it('targets the selected leaf instead of the active sibling', () => {
    const close = vi.fn(() => true)
    unsubscribes.push(onActiveTerminalPaneCloseRequest('tab-a', close))
    expect(requestActiveTerminalPaneClose('tab-a', 'leaf-b')).toBe(true)
    expect(close).toHaveBeenCalledWith('leaf-b')
    expect(requestActiveTerminalPaneClose('unmounted-tab', 'leaf-b')).toBe(false)
  })
})

it('leaves a close request unhandled until the pane manager is ready', async () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const close = vi.fn(() => true)
  function Probe() {
    useTerminalPaneCloseRequest({ tabId: 'loading-tab', managerRef: { current: null } }, close)
    return null
  }
  try {
    await act(async () => root.render(createElement(Probe)))
    expect(requestActiveTerminalPaneClose('loading-tab', 'missing-leaf')).toBe(false)
    expect(close).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
  }
})
